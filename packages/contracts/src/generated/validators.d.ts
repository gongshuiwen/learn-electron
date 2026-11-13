// Generated from api/openapi.yaml. DO NOT EDIT.
// Run npm run generate:contracts.
import type { HttpSchemas } from './types.ts'
export declare function ApiVersion(value: unknown): value is HttpSchemas['ApiVersion']
export declare function ServiceVersionInfo(
  value: unknown,
): value is HttpSchemas['ServiceVersionInfo']
export declare function Identifier(value: unknown): value is HttpSchemas['Identifier']
export declare function ModelId(value: unknown): value is HttpSchemas['ModelId']
export declare function ModelRef(value: unknown): value is HttpSchemas['ModelRef']
export declare function ModelBinding(value: unknown): value is HttpSchemas['ModelBinding']
export declare function ModelStatus(value: unknown): value is HttpSchemas['ModelStatus']
export declare function ServiceMeta(value: unknown): value is HttpSchemas['ServiceMeta']
export declare function Conversation(value: unknown): value is HttpSchemas['Conversation']
export declare function Conversations(value: unknown): value is HttpSchemas['Conversations']
export declare function Message(value: unknown): value is HttpSchemas['Message']
export declare function RunStatus(value: unknown): value is HttpSchemas['RunStatus']
export declare function Run(value: unknown): value is HttpSchemas['Run']
export declare function Sequence(value: unknown): value is HttpSchemas['Sequence']
export declare function ConversationSnapshot(
  value: unknown,
): value is HttpSchemas['ConversationSnapshot']
export declare function RunEvent(value: unknown): value is HttpSchemas['RunEvent']
export declare function StartRunRequest(value: unknown): value is HttpSchemas['StartRunRequest']
export declare function RenameConversationRequest(
  value: unknown,
): value is HttpSchemas['RenameConversationRequest']
export declare function CreateConversationRequest(
  value: unknown,
): value is HttpSchemas['CreateConversationRequest']
export declare function ApiError(value: unknown): value is HttpSchemas['ApiError']
export declare function Protocol(value: unknown): value is HttpSchemas['Protocol']
export declare function ModelDefinitionInput(
  value: unknown,
): value is HttpSchemas['ModelDefinitionInput']
export declare function ModelDefinition(value: unknown): value is HttpSchemas['ModelDefinition']
export declare function ModelDefinitions(value: unknown): value is HttpSchemas['ModelDefinitions']
export declare function Compatibility(value: unknown): value is HttpSchemas['Compatibility']
export declare function ConnectionConfigInput(
  value: unknown,
): value is HttpSchemas['ConnectionConfigInput']
export declare function ConnectionConfig(value: unknown): value is HttpSchemas['ConnectionConfig']
export declare function CredentialHeaders(value: unknown): value is HttpSchemas['CredentialHeaders']
export declare function SaveProviderRequest(
  value: unknown,
): value is HttpSchemas['SaveProviderRequest']
export declare function CreateChatGPTProviderRequest(
  value: unknown,
): value is HttpSchemas['CreateChatGPTProviderRequest']
export declare function CreateProviderRequest(
  value: unknown,
): value is HttpSchemas['CreateProviderRequest']
export declare function EndpointInstanceView(
  value: unknown,
): value is HttpSchemas['EndpointInstanceView']
export declare function ChatGPTProfile(value: unknown): value is HttpSchemas['ChatGPTProfile']
export declare function ChatGPTInstanceView(
  value: unknown,
): value is HttpSchemas['ChatGPTInstanceView']
export declare function ProviderInstanceView(
  value: unknown,
): value is HttpSchemas['ProviderInstanceView']
export declare function ProvidersState(value: unknown): value is HttpSchemas['ProvidersState']
export declare function ModelAdapterView(value: unknown): value is HttpSchemas['ModelAdapterView']
export declare function ModelAdapters(value: unknown): value is HttpSchemas['ModelAdapters']
export declare function ProviderTestRequest(
  value: unknown,
): value is HttpSchemas['ProviderTestRequest']
export declare function ChatGPTModel(value: unknown): value is HttpSchemas['ChatGPTModel']
export declare function ChatGPTModels(value: unknown): value is HttpSchemas['ChatGPTModels']
export declare function ChatGPTLogin(value: unknown): value is HttpSchemas['ChatGPTLogin']
export declare function LogoutResult(value: unknown): value is HttpSchemas['LogoutResult']
