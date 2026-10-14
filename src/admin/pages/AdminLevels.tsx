import { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../api'
import { AdminPageHeader, useAdminMutation } from '../AdminShared'
import { formatMultiplier } from '../../../shared/levels'
import { useToast } from '../../components/Toast'
import './AdminPages.css'

type Draft = {
  level: number
  topup: string
  weight: string
}

const DEFAULT_DRAFTS: Draft[] = [
  { level: 1, topup: '0', weight: '3' },
  { level: 2, topup: '20', weight: '2.5' },
  { level: 3, topup: '50', weight: '2' },
  { level: 4, topup: '100', weight: '1.5' },
  { level: 5, topup: '200', weight: '1' },
]

export function AdminLevels() {
  const { toast } = useToast()
  const [drafts, setDrafts] = useState<Draft[]>(DEFAULT_DRAFTS)
  const [loading, setLoading] = useState(true)
  const { run, busy } = useAdminMutation(() => undefined)

  useEffect(() => {
    void adminApi
      .levels()
      .then((data) => {
        setDrafts(
          DEFAULT_DRAFTS.map((slot) => {
            const row = data.levels.find((item) => item.level === slot.level)
            if (!row) return slot
            return {
              level: slot.level,
              topup: String(row.topupUsd),
              weight: String(row.weight),
            }
          }),
        )
      })
      .catch(() => toast('Could not load levels', 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  const total = useMemo(
    () => drafts.reduce((sum, row) => sum + (row.level === 1 ? 0 : Number(row.topup) || 0), 0),
    [drafts],
  )

  function update(level: number, patch: Partial<Draft>) {
    setDrafts((current) => current.map((row) => (row.level === level ? { ...row, ...patch } : row)))
  }

  function save() {
    for (const row of drafts) {
      const weight = Number(row.weight)
      if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
        toast(`Level ${row.level} multiplier must be between 0 and 100`, 'error')
        return
      }
      if (row.level > 1) {
        const topup = Number(row.topup)
        if (!Number.isFinite(topup) || topup < 0.01) {
          toast(`Level ${row.level} needs a top-up of at least $0.01`, 'error')
          return
        }
      }
    }
    void run(async () => {
      const saved = await adminApi.updateLevels(
        drafts.map((row) => ({
          level: row.level,
          topupUsd: row.level === 1 ? 0 : Number(row.topup),
          weight: Number(row.weight),
        })),
      )
      setDrafts(
        saved.levels.map((row) => ({
          level: row.level,
          topup: String(row.topupUsd),
          weight: String(row.weight),
        })),
      )
    }, 'Levels saved')
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Levels"
        description="FREE Token Weight for free models. Each level has its own fresh top-up goal."
      />

      <section className="admin-card">
        <div className="admin-card-header">
          <div>
            <h2>Free model multipliers</h2>
            <p>
              Level 1 is granted at signup. Reaching level 5 costs ${total.toFixed(2)} in fresh payments across every goal.
              A payment can be split across invoices, and extra amount fills the next goal.
            </p>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy || loading} onClick={save}>
            Save levels
          </button>
        </div>
        <div className="admin-card-body">
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>How it is earned</th>
                  <th>Top-up needed</th>
                  <th>FREE Token Weight</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((row) => (
                  <tr key={row.level}>
                    <td>
                      <strong>Level {row.level}</strong>
                    </td>
                    <td className="admin-muted">
                      {row.level === 1 ? 'Granted on registration' : `Fresh $${row.topup || '0'} after level ${row.level - 1}`}
                    </td>
                    <td>
                      {row.level === 1 ? (
                        <span className="mono">Signup</span>
                      ) : (
                        <label className="admin-inline-field">
                          <span>$</span>
                          <input
                            className="input"
                            inputMode="decimal"
                            value={row.topup}
                            disabled={loading}
                            aria-label={`Level ${row.level} top-up`}
                            onChange={(event) => update(row.level, { topup: event.target.value })}
                          />
                        </label>
                      )}
                    </td>
                    <td>
                      <label className="admin-inline-field">
                        <span>x</span>
                        <input
                          className="input"
                          inputMode="decimal"
                          value={row.weight}
                          disabled={loading}
                          aria-label={`Level ${row.level} multiplier`}
                          onChange={(event) => update(row.level, { weight: event.target.value })}
                        />
                        <small>{formatMultiplier(Number(row.weight) || 0)}</small>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  )
}
