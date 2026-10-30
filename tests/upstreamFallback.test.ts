import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyUpstreamPayloadQuirks,
  isProviderVariantRetryableError,
  MODEL_UPSTREAM_FALLBACKS,
  upstreamFailureMessage,
  upstreamFallbacksFor,
} from '../server/gateway.ts'

const DEEPSEEK_ROUTES = [
  'deepseek/v4-flash',
  'deepseek/v4-pro',
  'free/deepseek-v4-flash',
  'free/deepseek-v4-flash-0731',
  'deepseek/v4-flash-0731',
  'free/deepseek-v4-pro',
  'free/deepseek-v4-pro-0813',
  'deepseek/v4-pro-0813',
]
const LUNA_ROUTES = ['gpt/5.6-luna']
const TERRA_ROUTES = ['free/gpt-5.6-terra', 'gpt/5.6-terra']
const GEMINI_ROUTES = [
  'free/gemini-3.1-pro',
  'gemini/3.1-pro',
  'free/gemini-3.7-flash',
  'gemini/3.7-flash',
]
const GLM_ROUTES = ['free/glm-5.3-flash', 'glm/5.3-flash', 'glm/5.3']
const QWEN_MAX_ROUTES = ['free/qwen-3.8-max']

test('AbortError reports the actual streaming or non-streaming upstream timeout', () => {
  const aborted = new DOMException('This operation was aborted', 'AbortError')
  assert.equal(upstreamFailureMessage(aborted, { stream: true }), 'Upstream request timed out after 30s')
  assert.equal(upstreamFailureMessage(aborted, { stream: false }), 'Upstream request timed out after 180s')
  assert.equal(upstreamFailureMessage(aborted, { stream: false }, true, 'apinex'), 'Upstream request timed out after 45s')
})

test('the open-source template does not ship hardcoded fallback chains', () => {
  assert.deepEqual(MODEL_UPSTREAM_FALLBACKS, {})
  for (const modelId of [...DEEPSEEK_ROUTES, ...GLM_ROUTES, ...LUNA_ROUTES, ...TERRA_ROUTES, ...GEMINI_ROUTES, ...QWEN_MAX_ROUTES]) {
    assert.deepEqual(upstreamFallbacksFor(modelId), [])
  }
  assert.equal(isProviderVariantRetryableError('apinex', 400, 'reasoning_content'), false)
})


test('Kimi K3 has no fallback', () => {
  assert.deepEqual(upstreamFallbacksFor('kimi/k3'), [])
})


test('tool parameters schema sanitizes invalid regex, missing parameters, and invalid required', () => {
  const payload: Record<string, unknown> = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'fn1',
          // missing parameters
        },
      },
      {
        type: 'function',
        function: {
          name: 'fn2',
          parameters: {
            type: 'object',
            required: null,
            properties: {
              path: {
                type: 'string',
                pattern: '^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}"\\\\./[\\]]{1,200}$',
              },
              valid: {
                type: 'string',
                pattern: '^[a-z0-9]+$',
              },
            },
          },
        },
      },
    ],
  }

  applyUpstreamPayloadQuirks(payload, 'apinex')

  const tools = payload.tools as Array<{ function: { parameters: Record<string, unknown> } }>
  // fn1 gets default object parameters
  assert.deepEqual(tools[0].function.parameters, { type: 'object', properties: {} })

  // fn2 has required: null removed, invalid Unicode pattern removed, valid pattern preserved
  const fn2Params = tools[1].function.parameters
  assert.equal('required' in fn2Params, false)
  const props = fn2Params.properties as Record<string, { pattern?: string }>
  assert.equal('pattern' in props.path, false)
  assert.equal(props.valid.pattern, '^[a-z0-9]+$')
})

test('call_id longer than 64 characters is truncated across messages and input', () => {
  const longId = 'call_1234567890123456789012345678901234567890123456789012345678901234567890'
  assert.ok(longId.length > 64)

  const payload: Record<string, unknown> = {
    messages: [
      {
        role: 'assistant',
        tool_calls: [{ id: longId, type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: longId,
        content: 'result',
      },
    ],
    input: [
      {
        type: 'function_call',
        call_id: longId,
        name: 'f',
      },
    ],
  }

  applyUpstreamPayloadQuirks(payload, 'apinex')

  const msgs = payload.messages as Array<Record<string, unknown>>
  const assistantToolCalls = msgs[0].tool_calls as Array<{ id: string }>
  const toolMsg = msgs[1] as { tool_call_id: string }

  assert.equal(assistantToolCalls[0].id.length, 64)
  assert.equal(toolMsg.tool_call_id.length, 64)
  assert.equal(assistantToolCalls[0].id, toolMsg.tool_call_id)

  const inputArr = payload.input as Array<{ call_id: string }>
  assert.equal(inputArr[0].call_id.length, 64)
})

test('tool pairing adapts tool_call_id to match preceding assistant tool_calls when mismatched', () => {
  const payload: Record<string, unknown> = {
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'ac9df4c1-3767-40cc-bf9e-3b9e63a44c37',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"ls"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'file.txt',
      },
    ],
  }

  applyUpstreamPayloadQuirks(payload, 'apinex')

  const msgs = payload.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1].role, 'assistant')
  assert.equal(
    ((msgs[1].tool_calls as Array<{ id: string }>)[0]).id,
    'ac9df4c1-3767-40cc-bf9e-3b9e63a44c37',
  )
  assert.equal(msgs[2].role, 'tool')
  assert.equal(msgs[2].tool_call_id, 'ac9df4c1-3767-40cc-bf9e-3b9e63a44c37')
})

test('tool pairing prunes unanswered assistant tool_calls and converts orphaned tool messages', () => {
  const payload: Record<string, unknown> = {
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_answered', type: 'function', function: { name: 'f1', arguments: '{}' } },
          { id: 'call_unanswered', type: 'function', function: { name: 'f2', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_answered', content: 'ok' },
    ],
  }

  applyUpstreamPayloadQuirks(payload, 'apinex')

  const msgs = payload.messages as Array<Record<string, unknown>>
  assert.equal((msgs[0].tool_calls as Array<{ id: string }>).length, 1)
  assert.equal((msgs[0].tool_calls as Array<{ id: string }>)[0].id, 'call_answered')
  assert.equal(msgs[1].role, 'tool')
  assert.equal(msgs[1].tool_call_id, 'call_answered')
})

test('tool pairing converts tool message that does not follow assistant tool_calls to user message', () => {
  const payload: Record<string, unknown> = {
    messages: [
      { role: 'assistant', content: 'Here is some normal output without tools' },
      { role: 'tool', tool_call_id: 'call_orphan', content: 'orphan tool result' },
    ],
  }

  applyUpstreamPayloadQuirks(payload, 'apinex')

  const msgs = payload.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'assistant')
  assert.equal(msgs[1].role, 'user')
  assert.match(String(msgs[1].content), /orphan tool result/)
})
