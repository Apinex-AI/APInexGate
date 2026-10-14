import { useState, type InputHTMLAttributes } from 'react'
import './PasswordField.css'

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string
}

export function PasswordField({ label, id, className, ...props }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  const inputId = id ?? 'password-field'

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="password-field">
        <input
          {...props}
          id={inputId}
          className={`input password-field-input ${className ?? ''}`.trim()}
          type={visible ? 'text' : 'password'}
        />
        <button
          className="password-field-toggle"
          type="button"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          onClick={() => setVisible((value) => !value)}
          tabIndex={-1}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3l18 18" strokeLinecap="round" />
      <path
        d="M10.6 10.6a2.5 2.5 0 0 0 3.5 3.5M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a18.4 18.4 0 0 1-2.2 3.1M6.1 6.1A18 18 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.3-1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
