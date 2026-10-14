import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatResponseToResponses,
  responsesRequestToChat,
  ResponsesStreamEncoder,
  rewriteNativeResponsesEvent,
  upstreamSupportsResponses,
} from '../server/responsesCompat.ts'

test('APInex has no native /v1/responses endpoint', () => {
  assert.equal(upstreamSupportsResponses('apinex'), false)
})

test('a string input becomes a single user message', () => {
  const chat = responsesRequestToChat({ model: 'm', input: 'hello', max_output_tokens: 32 })
  assert.deepEqual(chat.messages, [{ role: 'user', content: 'hello' }])
  assert.equal(chat.max_tokens, 32)
  assert.equal(chat.stream, false)
})

test('instructions become a leading system message', () => {
  const chat = responsesRequestToChat({ model: 'm', instructions: 'Be terse.', input: 'hi' })
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'hi' },
  ])
})

test('structured input items map to chat roles and text', () => {
  const chat = responsesRequestToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'policy' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  })
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ])
})

test('a tool round trip keeps call ids so the provider can pair them', () => {
  const chat = responsesRequestToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Riga"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '17C' },
    ],
  })
  assert.deepEqual(chat.messages, [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Riga"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '17C' },
  ])
})

test('parallel function calls collapse into one assistant turn', () => {
  const chat = responsesRequestToChat({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'a', name: 'one', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'two', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: '1' },
      { type: 'function_call_output', call_id: 'b', output: '2' },
    ],
  })
  const messages = chat.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 3)
  assert.equal((messages[0].tool_calls as unknown[]).length, 2)
  assert.equal(messages[1].role, 'tool')
  assert.equal(messages[2].role, 'tool')
})

test('flat Responses tools convert to the nested chat contract', () => {
  const chat = responsesRequestToChat({
    model: 'm',
    input: 'hi',
    tools: [{ type: 'function', name: 'add', description: 'sum', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'add' },
  })
  assert.deepEqual(chat.tools, [
    { type: 'function', function: { name: 'add', description: 'sum', parameters: { type: 'object' } } },
  ])
  assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'add' } })
})

test('Responses-only options are dropped instead of confusing a strict provider', () => {
  const chat = responsesRequestToChat({
    model: 'm',
    input: 'hi',
    store: true,
    previous_response_id: 'resp_x',
    include: ['reasoning.encrypted_content'],
    truncation: 'auto',
    background: true,
    reasoning: { effort: 'high' },
  })
  for (const key of ['store', 'previous_response_id', 'include', 'truncation', 'background', 'reasoning']) {
    assert.equal(key in chat, false, key)
  }
})

test('text.format carries structured output over to response_format', () => {
  const schema = { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } }
  const chat = responsesRequestToChat({ model: 'm', input: 'hi', text: { format: schema } })
  assert.deepEqual(chat.response_format, schema)
})

test('a flat Responses text.format is nested so a strict chat upstream accepts it', () => {
  const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }
  const chat = responsesRequestToChat({
    model: 'm',
    input: 'hi',
    text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } },
  })
  assert.deepEqual(chat.response_format, {
    type: 'json_schema',
    json_schema: { name: 'answer', schema, strict: true },
  })
})

test('a top-level flat response_format is nested the same way', () => {
  const schema = { type: 'object' }
  const chat = responsesRequestToChat({
    model: 'm',
    input: 'hi',
    response_format: { type: 'json_schema', name: 'answer', schema },
  })
  assert.deepEqual(chat.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema } })
})

test('json_object and schemaless formats are passed through unchanged', () => {
  assert.deepEqual(
    responsesRequestToChat({ model: 'm', input: 'hi', text: { format: { type: 'json_object' } } }).response_format,
    { type: 'json_object' },
  )
  assert.deepEqual(
    responsesRequestToChat({ model: 'm', input: 'hi', text: { format: { type: 'json_schema', name: 'x' } } })
      .response_format,
    { type: 'json_schema', name: 'x' },
  )
})

test('a chat completion becomes a completed Responses object', () => {
  const response = chatResponseToResponses(
    {
      id: 'chatcmpl-1',
      created: 1700000000,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    },
    'free/deepseek-v4-flash-0731',
    { inputTokens: 12, outputTokens: 3, costTokens: 0 },
  )

  assert.equal(response.object, 'response')
  assert.equal(response.status, 'completed')
  assert.equal(response.model, 'free/deepseek-v4-flash-0731')
  assert.equal(response.output_text, 'pong')
  assert.deepEqual(response.output[0].content, [{ type: 'output_text', text: 'pong', annotations: [] }])
  assert.equal((response.usage as { input_tokens: number }).input_tokens, 12)
  assert.equal((response.usage as { output_tokens: number }).output_tokens, 3)
  assert.equal(response.incomplete_details, null)
})

test('a truncated completion is reported as incomplete, not completed', () => {
  const response = chatResponseToResponses(
    { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] },
    'm',
    { inputTokens: 5, outputTokens: 5 },
  )
  assert.equal(response.status, 'incomplete')
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' })
  assert.equal(response.completed_at, null)
})

test('tool calls surface as function_call output items', () => {
  const response = chatResponseToResponses(
    {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'add', arguments: '{"a":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'm',
    { inputTokens: 4, outputTokens: 6 },
  )
  assert.equal(response.output.length, 1)
  assert.equal(response.output[0].type, 'function_call')
  assert.equal(response.output[0].call_id, 'call_9')
  assert.equal(response.output[0].name, 'add')
  assert.equal(response.output[0].arguments, '{"a":1}')
})

function parseEvents(sse: string) {
  return sse
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const eventLine = block.split('\n').find((line) => line.startsWith('event: ')) ?? ''
      const dataLine = block.split('\n').find((line) => line.startsWith('data: ')) ?? ''
      return {
        event: eventLine.slice(7),
        data: dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : {},
      }
    })
}

test('an emulated text stream matches the native event sequence', () => {
  const encoder = new ResponsesStreamEncoder('free/deepseek-v4-flash-0731')
  let sse = ''
  sse += encoder.chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] })
  sse += encoder.chunk({ choices: [{ index: 0, delta: { content: 'lo' } }] })
  sse += encoder.chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  sse += encoder.finish({ inputTokens: 10, outputTokens: 2, costTokens: 0 })

  const events = parseEvents(sse)
  assert.deepEqual(
    events.map((e) => e.event),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ],
  )

  // sequence_number is monotonic, as a native stream guarantees.
  const sequence = events.map((e) => Number(e.data.sequence_number))
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b))
  assert.equal(new Set(sequence).size, sequence.length)

  const deltas = events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta)
  assert.deepEqual(deltas, ['Hel', 'lo'])

  const done = events.find((e) => e.event === 'response.output_text.done')
  assert.equal(done?.data.text, 'Hello')

  const completed = events.at(-1)
  const response = completed?.data.response as Record<string, unknown>
  assert.equal(response.status, 'completed')
  assert.equal(response.model, 'free/deepseek-v4-flash-0731')
  assert.equal(response.output_text, 'Hello')
  assert.equal((response.usage as { input_tokens: number }).input_tokens, 10)
})

test('an emulated tool-call stream emits argument deltas and a done event', () => {
  const encoder = new ResponsesStreamEncoder('m')
  let sse = ''
  sse += encoder.chunk({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'add', arguments: '{"a"' } }],
        },
      },
    ],
  })
  sse += encoder.chunk({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }],
  })
  sse += encoder.finish({ inputTokens: 3, outputTokens: 7 })

  const events = parseEvents(sse)
  const names = events.map((e) => e.event)
  assert.ok(names.includes('response.output_item.added'))
  assert.ok(names.includes('response.function_call_arguments.delta'))
  assert.ok(names.includes('response.function_call_arguments.done'))
  assert.equal(names.at(-1), 'response.completed')

  const argsDone = events.find((e) => e.event === 'response.function_call_arguments.done')
  assert.equal(argsDone?.data.arguments, '{"a":1}')

  const response = events.at(-1)?.data.response as Record<string, unknown>
  const output = response.output as Array<Record<string, unknown>>
  assert.equal(output[0].type, 'function_call')
  assert.equal(output[0].arguments, '{"a":1}')
  assert.equal(output[0].call_id, 'call_1')
})

test('an empty emulated stream still terminates with response.completed', () => {
  const encoder = new ResponsesStreamEncoder('m')
  const events = parseEvents(encoder.finish({ inputTokens: 1, outputTokens: 0 }))
  assert.deepEqual(
    events.map((e) => e.event),
    ['response.created', 'response.in_progress', 'response.completed'],
  )
})

test('a native Responses event is relabelled with the public model and yields usage', () => {
  const chunk = {
    type: 'response.completed',
    response: {
      model: 'gpt-5.6-luna',
      usage: { input_tokens: 9, output_tokens: 4 },
    },
  }
  const { usage } = rewriteNativeResponsesEvent(chunk, 'free/gpt-5.6-luna')
  assert.equal((chunk.response as { model: string }).model, 'free/gpt-5.6-luna')
  assert.deepEqual(usage, { inputTokens: 9, outputTokens: 4 })
})

test('a native event without usage leaves billing to the caller', () => {
  const chunk = { type: 'response.output_text.delta', delta: 'x' }
  assert.deepEqual(rewriteNativeResponsesEvent(chunk, 'm').usage, null)
  const inProgress = { type: 'response.in_progress', response: { model: 'upstream-name' } }
  assert.deepEqual(rewriteNativeResponsesEvent(inProgress, 'public/name').usage, null)
  assert.equal((inProgress.response as { model: string }).model, 'public/name')
})
