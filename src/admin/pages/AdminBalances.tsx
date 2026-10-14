import { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../api'
import type { BalanceTransaction } from '../types'
import {
  AdminPageHeader,
  CopyText,
  EmptyState,
  formatDate,
  SearchField,
  StatusBadge,
  useAdminMutation,
} from '../AdminShared'
import { formatUsdExact } from '../../../shared/billing'
import './AdminPages.css'

export function AdminBalances() {
  const [transactions, setTransactions] = useState<BalanceTransaction[]>([])
  const [query, setQuery] = useState('')
  const [email, setEmail] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  const refresh = () => {
    void adminApi
      .balances()
      .then((balanceData) => {
        setTransactions(balanceData.transactions)
      })
      .catch(() => undefined)
  }

  useEffect(refresh, [])
  const { run, busy } = useAdminMutation(refresh)

  const filtered = useMemo(
    () =>
      transactions.filter((tx) =>
        `${tx.email} ${tx.type} ${tx.note}`.toLowerCase().includes(query.toLowerCase().trim()),
      ),
    [transactions, query],
  )

  function adjust() {
    const usd = Number(amount)
    if (!email.trim() || !Number.isFinite(usd) || Math.abs(usd) < 0.01 || !note.trim()) return
    void run(
      () => adminApi.adjustBalance({ email: email.trim(), amountUsd: usd, note }),
      'Balance adjusted',
    )
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Balances"
        description="Ledger of real top-ups, debits and manual adjustments. Billing & Telegram live under Settings."
        actions={<SearchField value={query} onChange={setQuery} placeholder="Search transactions…" />}
      />

      <section className="admin-card admin-adjust-card">
        <div>
          <span className="eyebrow">Manual adjustment</span>
          <h2>Credit or debit a user balance</h2>
          <p>Enter the customer email and USD amount (positive or negative, min $0.01). Every adjustment creates a transaction and an audit log entry.</p>
        </div>
        <div className="admin-adjust-fields">
          <input
            className="input"
            type="email"
            placeholder="user@email.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            className="input"
            inputMode="decimal"
            placeholder="USD, e.g. 5.00 or -1.25"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <input
            className="input"
            placeholder="Reason"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy || !email.trim() || !amount || !note.trim() || Math.abs(Number(amount) || 0) < 0.01}
            onClick={adjust}
          >
            Apply
          </button>
        </div>
      </section>

      <div className="admin-card admin-table-wrap admin-balances-table-wrap">
        {filtered.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            description="Top-ups and adjustments will appear here as soon as they happen."
          />
        ) : (
          <table className="admin-table admin-table-fixed-rows">
            <thead>
              <tr>
                <th>Email</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Note</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tx) => (
                <tr key={tx.id}>
                  <td>
                    <CopyText value={tx.email} label="Email">
                      {tx.email}
                    </CopyText>
                  </td>
                  <td>
                    <span className="admin-chip">{tx.type}</span>
                  </td>
                  <td className={`mono ${(tx.amount_cents ?? 0) >= 0 ? 'money-positive' : 'money-negative'}`}>
                    {(tx.amount_cents ?? 0) > 0 ? '+' : ''}
                    {formatUsdExact((tx.amount_cents ?? 0) / 100)}
                  </td>
                  <td>{tx.note}</td>
                  <td>
                    <StatusBadge value={tx.status} />
                  </td>
                  <td>{formatDate(tx.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
