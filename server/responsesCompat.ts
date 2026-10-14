/**
 * OpenAI Responses API compatibility layer.
 *
 * Some upstreams expose only
 * `/v1/chat/completions` and answer `/v1/responses` with 400/404. Codex-style
 * clients speak Responses exclusively, so every such request used to fail the
 * primary upstream and burn a paid fallback.
 *
 * This module translates Responses ⇄ chat.completions in both directions so the
 * caller keeps talking Responses while the request is served by a chat-only
 * provider. Shapes mirror what a native Responses upstream returns, captured
 * from a live provider rather than guessed.
 */

/** APInex is chat-completions only. Responses requests are translated. */
export const UPSTREAMS_WITH_NATIVE_RESPONSES = new Set<string>()

export function upstreamSupportsResponses(provider: string) {
  return UPSTREAMS_WITH_NATIVE_RESPONSES.has(provider)
}

function randomId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const row = part as Record<string, unknown>
      // input_text / output_text / text all carry the payload in `text`.
      if (typeof row.text === 'string') return row.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Responses tools are flat; chat.completions nests them under `function`. */
function responsesToolsToChat(tools: unknown) {
  if (!Array.isArray(tools)) return undefined
  const converted = tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null
      const row = tool as Record<string, unknown>
      // Already in chat shape.
      if (row.function && typeof row.function === 'object') return row
      if (row.type !== 'function' || typeof row.name !== 'string') return null
      return {
        type: 'function',
        function: {
          name: row.name,
          ...(typeof row.description === 'string' ? { description: row.description } : {}),
          ...(row.parameters && typeof row.parameters === 'object' ? { parameters: row.parameters } : {}),
        },
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>
  return converted.length ? converted : undefined
}

function responsesToolChoiceToChat(toolChoice: unknown) {
  if (typeof toolChoice === 'string') return toolChoice
  if (!toolChoice || typeof toolChoice !== 'object') return undefined
  const row = toolChoice as Record<string, unknown>
  if (row.type === 'function' && typeof row.name === 'string') {
    return { type: 'function', function: { name: row.name } }
  }
  return undefined
}

/**
 * Responses `input` → chat `messages`.
 *
 * `input` is either a plain string or a list mixing message items, model
 * function calls, and function call outputs. Tool results must keep their
 * `call_id` so the provider can pair them with the originating call.
 */
function responsesInputToMessages(input: unknown, instructions: unknown) {
  const messages: Array<Record<string, unknown>> = []

  const instructionText =
    typeof instructions === 'string' && instructions.trim() ? instructions.trim() : ''
  if (instructionText) messages.push({ role: 'system', content: instructionText })

  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: input })
    return messages
  }
  if (!Array.isArray(input)) return messages

  // Consecutive model function calls belong to one assistant turn.
  let pendingToolCalls: Array<Record<string, unknown>> = []
  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return
    messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls })
    pendingToolCalls = []
  }

  for (const raw of input) {
    if (typeof raw === 'string') {
      flushToolCalls()
      if (raw.trim()) messages.push({ role: 'user', content: raw })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const type = String(item.type ?? (item.role ? 'message' : ''))

    if (type === 'function_call') {
      pendingToolCalls.push({
        id: String(item.call_id ?? item.id ?? randomId('call')),
        type: 'function',
        function: {
          name: String(item.name ?? 'tool'),
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      })
      continue
    }

    flushToolCalls()

    if (type === 'function_call_output') {
      const output = item.output
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? item.id ?? ''),
        content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      })
      continue
    }

    if (type === 'reasoning') continue // provider-side artefact, not replayable as chat

    const role = typeof item.role === 'string' ? item.role : 'user'
    const text = textFromResponsesContent(item.content)
    if (!text) continue
    messages.push({ role: role === 'developer' ? 'system' : role, content: text })
  }

  flushToolCalls()
  return messages
}

/**
 * Coerce a structured-output declaration into the chat.completions contract.
 *
 * The Responses API nests the schema *flat* (`{type, name, schema, strict}`) while
 * chat.completions expects it wrapped (`{type, json_schema: {...}}`). Copying the
 * Responses shape verbatim makes a strict upstream answer
 * `'response_format.json_schema' is required when 'response_format.type' is 'json_schema'`.
 */
export function normalizeChatResponseFormat(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const format = value as Record<string, unknown>
  if (format.type !== 'json_schema') return format

  // Already in chat shape.
  const nested = format.json_schema
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return format

  const { type: _type, json_schema: _ignored, ...rest } = format
  // Without a schema there is nothing to wrap; leaving it untouched keeps the
  // upstream's own validation message rather than inventing an empty schema.
  if (!('schema' in rest)) return format
  return { type: 'json_schema', json_schema: rest }
}

/**
 * Build a chat.completions request body from a Responses request.
 *
 * Only fields a chat endpoint understands are copied — Responses-only options
 * (`store`, `previous_response_id`, `include`, `truncation`, `background`,
 * `reasoning`) are dropped, because passing unknown parameters to a strict
 * provider is itself a source of 400s.
 */
export function responsesRequestToChat(body: Record<string, unknown>) {
  const payload: Record<string, unknown> = {
    model: body.model,
    messages: responsesInputToMessages(body.input, body.instructions),
    stream: Boolean(body.stream),
  }

  const maxOutput = body.max_output_tokens ?? body.max_tokens
  if (maxOutput != null) payload.max_tokens = maxOutput
  if (body.temperature != null) payload.temperature = body.temperature
  if (body.top_p != null) payload.top_p = body.top_p
  if (body.stop != null) payload.stop = body.stop

  const tools = responsesToolsToChat(body.tools)
  if (tools) payload.tools = tools
  const toolChoice = responsesToolChoiceToChat(body.tool_choice)
  if (toolChoice != null) payload.tool_choice = toolChoice
  if (typeof body.parallel_tool_calls === 'boolean') {
    payload.parallel_tool_calls = body.parallel_tool_calls
  }

  // Responses carries structured output under `text.format`; chat uses `response_format`.
  const textOptions = body.text && typeof body.text === 'object' ? (body.text as Record<string, unknown>) : null
  const format = textOptions?.format
  if (format && typeof format === 'object') payload.response_format = normalizeChatResponseFormat(format)
  else if (body.response_format && typeof body.response_format === 'object') {
    payload.response_format = normalizeChatResponseFormat(body.response_format)
  }

  return payload
}

function chatText(data: Record<string, unknown>) {
  const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
  const message = (choices[0]?.message ?? {}) as Record<string, unknown>
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) return textFromResponsesContent(message.content)
  return ''
}

function chatToolCalls(data: Record<string, unknown>) {
  const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
  const message = (choices[0]?.message ?? {}) as Record<string, unknown>
  return Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : []
}

function toolCallToResponsesItem(call: Record<string, unknown>) {
  const fn = (call.function && typeof call.function === 'object' ? call.function : {}) as Record<string, unknown>
  return {
    type: 'function_call',
    id: randomId('fc'),
    call_id: String(call.id ?? randomId('call')),
    name: String(fn.name ?? 'tool'),
    arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    status: 'completed',
  }
}

function responsesUsage(billed: { inputTokens: number; outputTokens: number; costTokens?: number }) {
  return {
    input_tokens: billed.inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: billed.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: billed.inputTokens + billed.outputTokens,
  }
}

const FINISH_TO_INCOMPLETE: Record<string, string> = {
  length: 'max_output_tokens',
  content_filter: 'content_filter',
}

/** chat.completion → Responses `response` object. */
export function chatResponseToResponses(
  data: Record<string, unknown>,
  publicModelId: string,
  billed: { inputTokens: number; outputTokens: number; costTokens?: number },
) {
  const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
  const finishReason = String(choices[0]?.finish_reason ?? 'stop')
  const text = chatText(data)
  const toolCalls = chatToolCalls(data)

  const output: Array<Record<string, unknown>> = []
  if (text) {
    output.push({
      type: 'message',
      id: randomId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const call of toolCalls) output.push(toolCallToResponsesItem(call))

  const createdAt = Number(data.created) || Math.floor(Date.now() / 1000)
  const incomplete = FINISH_TO_INCOMPLETE[finishReason]
  const complete = !incomplete

  return {
    id: typeof data.id === 'string' && data.id.startsWith('resp_') ? data.id : randomId('resp'),
    object: 'response',
    created_at: createdAt,
    model: publicModelId,
    output,
    // Convenience mirror of the assistant text, as provided by native upstreams.
    output_text: text,
    usage: responsesUsage(billed),
    status: complete ? 'completed' : 'incomplete',
    error: null,
    incomplete_details: incomplete ? { reason: incomplete } : null,
    completed_at: complete ? createdAt : null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    user: null,
  }
}

type StreamToolBlock = {
  outputIndex: number
  itemId: string
  callId: string
  name: string
  arguments: string
}

/**
 * Converts a stream of OpenAI chat chunks into Responses SSE events.
 *
 * Event names, field names and the monotonic `sequence_number` follow a live
 * native Responses stream, so a Codex-style client cannot tell the difference.
 */
export class ResponsesStreamEncoder {
  private sequence = 0
  private responseId = randomId('resp')
  private createdAt = Math.floor(Date.now() / 1000)
  private messageItemId = randomId('msg')
  private started = false
  private textStarted = false
  private textDone = false
  private text = ''
  private nextOutputIndex = 0
  private messageOutputIndex: number | null = null
  private toolBlocks = new Map<number, StreamToolBlock>()
  private finishReason = 'stop'

  constructor(private readonly publicModelId: string) {}

  private event(name: string, data: Record<string, unknown>) {
    const payload = { ...data, sequence_number: this.sequence++ }
    return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
  }

  private responseEnvelope(status: 'in_progress' | 'completed' | 'incomplete', extra: Record<string, unknown> = {}) {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      model: this.publicModelId,
      status,
      error: null,
      incomplete_details: null,
      output: [],
      ...extra,
    }
  }

  /** Emitted once, before any content. */
  start() {
    if (this.started) return ''
    this.started = true
    return (
      this.event('response.created', { type: 'response.created', response: this.responseEnvelope('in_progress') }) +
      this.event('response.in_progress', { type: 'response.in_progress', response: this.responseEnvelope('in_progress') })
    )
  }

  private beginText() {
    if (this.textStarted) return ''
    this.textStarted = true
    this.messageOutputIndex = this.nextOutputIndex++
    return (
      this.event('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: this.messageOutputIndex,
        item: { id: this.messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }) +
      this.event('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    )
  }

  private endText() {
    if (!this.textStarted || this.textDone) return ''
    this.textDone = true
    return (
      this.event('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        text: this.text,
        logprobs: [],
      }) +
      this.event('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: this.text, annotations: [] },
      }) +
      this.event('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: this.messageOutputIndex,
        item: {
          id: this.messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: this.text, annotations: [] }],
        },
      })
    )
  }

  /** Translate one chat.completions chunk. Returns the SSE text to forward. */
  chunk(chunk: Record<string, unknown>) {
    let out = this.start()
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Array<Record<string, unknown>>) : []
    const choice = choices[0]
    if (!choice) return out
    const delta = (choice.delta && typeof choice.delta === 'object' ? choice.delta : {}) as Record<string, unknown>

    if (typeof delta.content === 'string' && delta.content) {
      out += this.beginText()
      this.text += delta.content
      out += this.event('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        delta: delta.content,
      })
    }

    if (Array.isArray(delta.tool_calls)) {
      // A tool call closes any open text part, exactly like a native stream.
      out += this.endText()
      for (const rawCall of delta.tool_calls) {
        if (!rawCall || typeof rawCall !== 'object') continue
        const call = rawCall as Record<string, unknown>
        const sourceIndex = typeof call.index === 'number' ? call.index : this.toolBlocks.size
        const fn = (call.function && typeof call.function === 'object' ? call.function : {}) as Record<string, unknown>
        let block = this.toolBlocks.get(sourceIndex)
        if (!block) {
          block = {
            outputIndex: this.nextOutputIndex++,
            itemId: randomId('fc'),
            callId: String(call.id ?? randomId('call')),
            name: String(fn.name ?? 'tool'),
            arguments: '',
          }
          this.toolBlocks.set(sourceIndex, block)
          out += this.event('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: block.outputIndex,
            item: {
              id: block.itemId,
              type: 'function_call',
              status: 'in_progress',
              call_id: block.callId,
              name: block.name,
              arguments: '',
            },
          })
        }
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''
        if (args) {
          block.arguments += args
          out += this.event('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: block.itemId,
            output_index: block.outputIndex,
            delta: args,
          })
        }
      }
    }

    if (choice.finish_reason != null) this.finishReason = String(choice.finish_reason)
    return out
  }

  /** Emitted once, after the upstream stream ends. */
  finish(billed: { inputTokens: number; outputTokens: number; costTokens?: number }) {
    let out = this.start()
    out += this.endText()

    for (const block of this.toolBlocks.values()) {
      out += this.event('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: block.itemId,
        output_index: block.outputIndex,
        arguments: block.arguments,
      })
      out += this.event('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: block.outputIndex,
        item: {
          id: block.itemId,
          type: 'function_call',
          status: 'completed',
          call_id: block.callId,
          name: block.name,
          arguments: block.arguments,
        },
      })
    }

    const output: Array<Record<string, unknown>> = []
    if (this.textStarted) {
      output.push({
        id: this.messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.text, annotations: [] }],
      })
    }
    for (const block of this.toolBlocks.values()) {
      output.push({
        id: block.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: block.callId,
        name: block.name,
        arguments: block.arguments,
      })
    }

    const incomplete = FINISH_TO_INCOMPLETE[this.finishReason]
    const status = incomplete ? 'incomplete' : 'completed'
    out += this.event('response.completed', {
      type: 'response.completed',
      response: {
        ...this.responseEnvelope(status, {
          output,
          output_text: this.text,
          usage: responsesUsage(billed),
          incomplete_details: incomplete ? { reason: incomplete } : null,
          completed_at: Math.floor(Date.now() / 1000),
        }),
      },
    })
    return out
  }
}

/**
 * Native Responses streams carry the upstream model id inside the nested
 * `response` object and their usage there too. Rewrite the public id and read
 * usage so billing does not fall back to an estimate.
 */
export function rewriteNativeResponsesEvent(chunk: Record<string, unknown>, publicModelId: string) {
  const response = chunk.response
  if (!response || typeof response !== 'object') return { chunk, usage: null }
  const row = response as Record<string, unknown>
  row.model = publicModelId
  const usage = row.usage && typeof row.usage === 'object' ? (row.usage as Record<string, unknown>) : null
  if (!usage) return { chunk, usage: null }
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  return {
    chunk,
    usage:
      inputTokens || outputTokens
        ? { inputTokens: Math.max(0, inputTokens), outputTokens: Math.max(0, outputTokens) }
        : null,
  }
}
