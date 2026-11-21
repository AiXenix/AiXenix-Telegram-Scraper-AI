// Placeholders laid over the defaults to make the example config shipped with
// the standalone build (and written by `config init`). They show where your own
// values go; none of them work as is, and `config check` points them out.
export const EXAMPLE_OVERRIDES = {
  telegram: { botToken: "PASTE_BOT_TOKEN_FROM_BOTFATHER", channel: "@your_channel" },
  sources: ["@first_source_channel", "@second_source_channel"],
  llm: {
    backend: "openai",
    apiBaseUrl: "https://openrouter.ai/api/v1",
    apiKey: "PASTE_API_KEY",
    filterModel: "MODEL_FOR_FILTERING",
    writerModel: "MODEL_FOR_WRITING",
  },
  editorial: { footer: "@your_channel" },
};

/** Values above that mean "not filled in yet". */
export const PLACEHOLDER_PATTERN = /^(PASTE_|MODEL_FOR_)|^@?(your_channel|first_source_channel|second_source_channel)$/u;
