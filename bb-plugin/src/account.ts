// A Telegram user account, used the way the original Telethon script used
// it: to take a source post with all its photos, videos, albums, GIFs and
// files from Telegram itself. The web preview of a channel cannot give large
// videos and some kinds of files, and a bot cannot read channels it is not a
// member of. The account forwards the post to the bot for a moment, the bot
// keeps the file ids (which have no size limit), and the forwarded copy is
// deleted again.
import { Api, TelegramClient } from "telegram";
import { computeCheck } from "telegram/Password.js";
import { LogLevel, Logger } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";

export interface AccountUser {
  id: string;
  name: string;
  username: string | null;
}

/**
 * One message being forwarded, and how the bot will recognise it. A forward
 * carries the ORIGINAL message's origin: for a repost that is the channel it
 * came from, not the source channel, so the key is the original's date and id.
 */
export interface ForwardItem {
  /** The message id in the source channel. */
  sourceId: number;
  /** forward_origin.message_id the bot will see; null when the original was not a channel post. */
  originId: number | null;
  /** forward_origin.date the bot will see (unix seconds). */
  originDate: number;
}

export interface ForwardedPost {
  /** The post and the other items of its album, in the source channel. */
  items: ForwardItem[];
  /** The same messages in the account's chat with the bot. */
  forwardedIds: number[];
}

/** What the engine needs from an account. Tests pass a fake. */
export interface TelegramAccountLike {
  me(): Promise<AccountUser>;
  /**
   * Forwards the post (with the rest of its album) from a public channel to
   * the bot. `beforeForward` gets the items before anything is sent, so the
   * caller can wait for exactly those messages.
   */
  forwardPost(channel: string, msgId: number, botUsername: string, beforeForward: (items: ForwardItem[]) => void): Promise<ForwardedPost>;
  /** Deletes the forwarded copies in the chat with the bot, for both sides. */
  deleteForwarded(botUsername: string, ids: number[]): Promise<void>;
  close(): Promise<void>;
}

export type AccountErrorCode = "unauthorized" | "protected" | "not_found" | "flood" | "failed";

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = "AccountError";
    this.code = code;
  }
}

export interface AccountCredentials {
  apiId: number;
  apiHash: string;
}

/** SOCKS5 only: MTProto does not go through an HTTP proxy. "" and "env" mean a direct connection. */
export function accountProxy(proxy: string): { ip: string; port: number; socksType: 5; username?: string; password?: string } | null {
  const trimmed = proxy.trim();
  if (!/^socks5h?:\/\//iu.test(trimmed)) return null;
  const url = new URL(trimmed.replace(/^socks5h:/iu, "socks5:"));
  return {
    ip: url.hostname,
    port: Number(url.port || 1080),
    socksType: 5,
    ...(url.username === "" ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === "" ? {} : { password: decodeURIComponent(url.password) }),
  };
}

const DEVICE = { deviceModel: "Newsdesk", systemVersion: "Node.js", appVersion: "1.2", langCode: "ru", systemLangCode: "ru-RU" };

function newClient(credentials: AccountCredentials, session: string, proxy: string): TelegramClient {
  const socks = accountProxy(proxy);
  const client = new TelegramClient(new StringSession(session), credentials.apiId, credentials.apiHash, {
    connectionRetries: 3,
    autoReconnect: true,
    floodSleepThreshold: 30,
    ...DEVICE,
    // Quiet: its own log would interleave with the service's.
    baseLogger: new Logger(LogLevel.NONE),
    ...(socks === null ? {} : { proxy: socks }),
  });
  return client;
}

function rpcMessage(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "errorMessage" in cause) return String((cause as { errorMessage: unknown }).errorMessage);
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * gramjs waits forever on a request when its connection is gone (and its
 * connect() reports failure by returning false). Every call goes through this,
 * so a dead connection becomes an error instead of a stuck pipeline.
 */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AccountError("failed", `Telegram не ответил за ${Math.round(ms / 1000)} с (${what})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Turns gramjs errors into the few cases the service treats differently. */
export function toAccountError(cause: unknown): AccountError {
  if (cause instanceof AccountError) return cause;
  const message = rpcMessage(cause);
  const seconds = typeof cause === "object" && cause !== null && "seconds" in cause ? Number((cause as { seconds: unknown }).seconds) : Number.NaN;
  if (Number.isFinite(seconds)) return new AccountError("flood", `Telegram просит подождать ${seconds} с`);
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/u.test(message)) {
    return new AccountError("unauthorized", "вход в аккаунт Telegram больше не действует, войдите заново");
  }
  if (/CHAT_FORWARDS_RESTRICTED|noforwards/iu.test(message)) {
    return new AccountError("protected", "канал запрещает пересылку и сохранение своих постов");
  }
  if (/FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT/u.test(message)) {
    return new AccountError("flood", `Telegram просит подождать: ${message}`);
  }
  if (/CHANNEL_INVALID|CHANNEL_PRIVATE|USERNAME_INVALID|USERNAME_NOT_OCCUPIED|MSG_ID_INVALID/u.test(message)) {
    return new AccountError("not_found", `пост недоступен аккаунту: ${message}`);
  }
  return new AccountError("failed", message);
}

function userView(user: Api.User): AccountUser {
  const name = [user.firstName, user.lastName].filter((part) => typeof part === "string" && part !== "").join(" ");
  return { id: String(user.id), name: name === "" ? String(user.id) : name, username: user.username ?? null };
}

export class TelegramAccount implements TelegramAccountLike {
  private readonly credentials: AccountCredentials;
  private readonly session: string;
  private readonly proxy: string;
  private client: TelegramClient | null = null;
  private connecting: Promise<TelegramClient> | null = null;

  constructor(credentials: AccountCredentials, session: string, proxy = "") {
    this.credentials = credentials;
    this.session = session;
    this.proxy = proxy;
  }

  private connected(): Promise<TelegramClient> {
    if (this.client !== null && this.client.connected === true) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const client = this.client ?? newClient(this.credentials, this.session, this.proxy);
      this.client = client;
      try {
        if (!(await within(client.connect(), 40_000, "подключение"))) {
          throw new AccountError("failed", "нет связи с Telegram для аккаунта (сеть или прокси)");
        }
        if (!(await within(client.checkAuthorization(), 30_000, "проверка входа"))) {
          throw new AccountError("unauthorized", "вход в аккаунт Telegram больше не действует, войдите заново");
        }
        return client;
      } catch (cause) {
        // A half-open client never recovers; the next call starts a fresh one.
        await this.reset();
        throw toAccountError(cause);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /** Runs one request; if it fails for want of an answer, the client is replaced before the next one. */
  private async call<T>(what: string, ms: number, request: (client: TelegramClient) => Promise<T>): Promise<T> {
    const client = await this.connected();
    try {
      return await within(request(client), ms, what);
    } catch (cause) {
      const error = toAccountError(cause);
      if (error.code === "failed") await this.reset();
      throw error;
    }
  }

  private async reset(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client !== null) await within(client.destroy(), 10_000, "отключение").catch(() => undefined);
  }

  me(): Promise<AccountUser> {
    return this.call("профиль", 30_000, async (client) => userView((await client.getMe()) as Api.User));
  }

  forwardPost(channel: string, msgId: number, botUsername: string, beforeForward: (items: ForwardItem[]) => void): Promise<ForwardedPost> {
    return this.call("пересылка поста", 60_000, async (client) => {
      const ids: number[] = [];
      for (let id = Math.max(1, msgId - 9); id <= msgId + 9; id += 1) ids.push(id);
      const around = (await client.getMessages(channel, { ids })).filter(
        (message): message is Api.Message => message instanceof Api.Message,
      );
      const post = around.find((message) => message.id === msgId);
      if (post === undefined) throw new AccountError("not_found", "пост не найден: удалён или канал закрыт");
      if (post.noforwards === true) throw new AccountError("protected", "канал запрещает пересылку и сохранение своих постов");
      const group = post.groupedId;
      const messages =
        group === undefined || group === null
          ? [post]
          : around.filter((message) => message.groupedId !== undefined && message.groupedId !== null && message.groupedId.equals(group));
      messages.sort((left, right) => left.id - right.id);
      const items = messages.map((message): ForwardItem => {
        const header = message.fwdFrom;
        if (header === undefined || header === null) return { sourceId: message.id, originId: message.id, originDate: message.date };
        // A repost: the bot will see where it was first posted.
        return { sourceId: message.id, originId: header.channelPost ?? null, originDate: header.date };
      });
      beforeForward(items);
      const forwarded = await client.forwardMessages(botUsername, { messages: messages.map((message) => message.id), fromPeer: channel, silent: true });
      // gramjs returns one list per source chat: [[message, message, ...]], whatever its types say.
      const forwardedIds = (Array.isArray(forwarded) ? (forwarded as unknown[]).flat(2) : [forwarded])
        .filter((message): message is Api.Message => message instanceof Api.Message)
        .map((message) => message.id);
      return { items, forwardedIds };
    });
  }

  async deleteForwarded(botUsername: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.call("удаление пересланного", 30_000, (client) => client.deleteMessages(botUsername, ids, { revoke: true }));
  }

  async close(): Promise<void> {
    await this.reset();
  }
}

// ---- login -------------------------------------------------------------------

export type LoginStep = { step: "code"; via: "app" | "sms" } | { step: "password"; hint: string | null } | { step: "done"; session: string; user: AccountUser };

/**
 * The three steps of signing in: phone number, the code Telegram sends, and
 * the cloud password if the account has one. One login keeps one connection
 * from the first step to the last.
 */
export class AccountLogin {
  private readonly client: TelegramClient;
  private readonly credentials: AccountCredentials;
  private phone = "";
  private phoneCodeHash = "";
  readonly startedAt = Date.now();

  constructor(credentials: AccountCredentials, proxy = "") {
    this.credentials = credentials;
    this.client = newClient(credentials, "", proxy);
  }

  async sendCode(phone: string): Promise<LoginStep> {
    this.phone = phone.replace(/[^\d+]/gu, "");
    try {
      if (!(await within(this.client.connect(), 40_000, "подключение"))) {
        throw new AccountError("failed", "нет связи с Telegram для входа (сеть или прокси)");
      }
      const sent = await within(this.client.sendCode(this.credentials, this.phone), 60_000, "отправка кода");
      this.phoneCodeHash = sent.phoneCodeHash;
      return { step: "code", via: sent.isCodeViaApp ? "app" : "sms" };
    } catch (cause) {
      throw new AccountError("failed", loginMessage(cause));
    }
  }

  async submitCode(code: string): Promise<LoginStep> {
    try {
      const result = await within(
        this.client.invoke(new Api.auth.SignIn({ phoneNumber: this.phone, phoneCodeHash: this.phoneCodeHash, phoneCode: code.replace(/\D/gu, "") })),
        60_000,
        "вход по коду",
      );
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new AccountError("failed", "на этот номер нет аккаунта Telegram");
      }
      return this.finish(result.user as Api.User);
    } catch (cause) {
      if (rpcMessage(cause).includes("SESSION_PASSWORD_NEEDED")) {
        const password = await within(this.client.invoke(new Api.account.GetPassword()), 60_000, "пароль");
        return { step: "password", hint: password.hint ?? null };
      }
      throw cause instanceof AccountError ? cause : new AccountError("failed", loginMessage(cause));
    }
  }

  async submitPassword(password: string): Promise<LoginStep> {
    try {
      const settings = await within(this.client.invoke(new Api.account.GetPassword()), 60_000, "пароль");
      const check = await computeCheck(settings, password);
      const result = await within(this.client.invoke(new Api.auth.CheckPassword({ password: check })), 60_000, "проверка пароля");
      if (!(result instanceof Api.auth.Authorization)) throw new AccountError("failed", "Telegram не принял вход");
      return this.finish(result.user as Api.User);
    } catch (cause) {
      throw cause instanceof AccountError ? cause : new AccountError("failed", loginMessage(cause));
    }
  }

  private async finish(user: Api.User): Promise<LoginStep> {
    const session = (this.client.session as StringSession).save();
    await this.cancel();
    return { step: "done", session, user: userView(user) };
  }

  async cancel(): Promise<void> {
    await within(this.client.destroy(), 10_000, "отключение").catch(() => undefined);
  }
}

function loginMessage(cause: unknown): string {
  const message = rpcMessage(cause);
  if (/PHONE_NUMBER_INVALID/u.test(message)) return "Telegram не знает такой номер. Пишите с кодом страны: +79991234567";
  if (/PHONE_CODE_INVALID/u.test(message)) return "Код неверный, проверьте и введите ещё раз";
  if (/PHONE_CODE_EXPIRED/u.test(message)) return "Код устарел, запросите новый";
  if (/PASSWORD_HASH_INVALID/u.test(message)) return "Пароль неверный";
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/u.test(message)) return "api_id или api_hash неверные: возьмите их на my.telegram.org";
  if (/FLOOD_WAIT_(\d+)/u.test(message)) return `Слишком много попыток, Telegram просит подождать ${/FLOOD_WAIT_(\d+)/u.exec(message)?.[1]} с`;
  return message;
}

/** A Telethon session file (SQLite) as a session string for this client: lets an old login be reused. */
export async function sessionFromTelethon(row: { dc_id: number; server_address: string; port: number; auth_key: Uint8Array }): Promise<string> {
  const { AuthKey } = await import("telegram/crypto/AuthKey.js");
  const session = new StringSession("");
  session.setDC(row.dc_id, row.server_address, row.port);
  const key = new AuthKey();
  await key.setKey(Buffer.from(row.auth_key));
  session.setAuthKey(key);
  return session.save();
}
