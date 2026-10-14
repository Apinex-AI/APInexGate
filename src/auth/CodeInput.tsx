import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'

type CodeInputProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  length?: number
  autoFocus?: boolean
}

export function CodeInput({
  value,
  onChange,
  disabled = false,
  length = 6,
  autoFocus = true,
}: CodeInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const digits = Array.from({ length }, (_, i) => value[i] ?? '')

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
  }, [autoFocus])

  function setDigit(index: number, raw: string) {
    const char = raw.replace(/\D/g, '').slice(-1)
    const next = digits.map((d, i) => (i === index ? char : d))
    const joined = next.join('').slice(0, length)
    onChange(joined)
    if (char && index < length - 1) refs.current[index + 1]?.focus()
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (digits[index]) {
        const next = digits.map((d, i) => (i === index ? '' : d))
        onChange(next.join(''))
      } else if (index > 0) {
        refs.current[index - 1]?.focus()
        const next = digits.map((d, i) => (i === index - 1 ? '' : d))
        onChange(next.join(''))
      }
    }
    if (event.key === 'ArrowLeft' && index > 0) refs.current[index - 1]?.focus()
    if (event.key === 'ArrowRight' && index < length - 1) refs.current[index + 1]?.focus()
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault()
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, length)
    if (!pasted) return
    onChange(pasted)
    refs.current[Math.min(pasted.length, length) - 1]?.focus()
  }

  return (
    <div className="code-input" role="group" aria-label="Verification code">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el
          }}
          className="code-input-cell"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={digit}
          disabled={disabled}
          onChange={(event) => setDigit(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={onPaste}
          onFocus={(event) => event.target.select()}
          aria-label={`Digit ${index + 1}`}
        />
      ))}
    </div>
  )
}
