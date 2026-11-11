import { openAIChat, openAIResponses } from './openai.ts'
import { anthropic } from './anthropic.ts'
import { google } from './google.ts'

/** Static implementations; connection configuration never loads executable plugins. */
export const protocolAdapters = {
  'openai-chat': openAIChat,
  'openai-responses': openAIResponses,
  'anthropic-messages': anthropic,
  'google-generative': google,
}
