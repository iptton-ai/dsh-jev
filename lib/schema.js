const entry = {
  oneOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: true },
    { type: 'array', items: { type: 'json' } },
  ],
}

export const PARAMETERS = {
  state: {
    ...entry,
    required: true,
    description: 'Content to evaluate: plain text, a JSON record, or an array such as chat messages. TypeSafe receives this content.',
  },
  questions: {
    type: 'object',
    additionalProperties: true,
    required: true,
    description: 'Non-empty map from question ID to {type, instructions, criteria?}; instructions is a string, JSON object or array. type="noul" returns P(yes), with optional criteria {true: description, false: description}. type="choice" requires criteria {option: description} with 1–255 options. type="score" requires an ordered criteria array of 2–10 level descriptions indexed from zero; the result may be fractional. Descriptions can be strings, JSON objects/arrays or null. Mix all three question types in one call; answers use the same IDs.',
    examples: [{
      urgent: { type: 'noul', instructions: 'Is this time-sensitive?' },
      team: { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: 'Payments and refunds', technical: 'Bugs and outages' } },
      frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
    }],
  },
  model: {
    type: 'string',
    description: 'Optional TypeSafe model ID or alias; uses the plugin setting when omitted (jev-latest by default).',
  },
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    model: { type: 'string', required: true, description: 'Actual model used by TypeSafe.' },
    answers: {
      type: 'object', additionalProperties: true, required: true,
      description: 'Answers keyed by question ID: Noul {type,noul}; Choice {type,choice,probabilities,confidence}; Score {type,score,legend,probabilities,confidence}. Probabilities and confidence are between 0 and 1. Score uses zero-based rubric indices.',
    },
    usage: {
      type: 'object', additionalProperties: true, required: true,
      properties: {
        input_tokens: { type: 'integer', required: true },
        output_tokens: { type: 'integer', required: true },
      },
    },
  },
}
