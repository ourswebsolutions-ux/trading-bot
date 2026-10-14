import { useState } from 'react'
import type { AppNotification } from '@shared/ipc'
import { Icon, type IconName } from '../components/icons'
import { Button, ConfirmDialog, Empty, ErrorState, Panel, Segmented, Skeleton, useToast } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { ago, dateTime } from '../lib/format'
import { useEvent, useResource } from '../lib/hooks'

const SEVERITY: Record<AppNotification['severity'], { icon: IconName; color: string }> = {
  info: { icon: 'info', color: 'var(--info)' },
  success: { icon: 'check', color: 'var(--up)' },
  warning: { icon: 'alert', color: 'var(--warn)' },
  error: { icon: 'alert', color: 'var(--down)' }
}

type Filter = 'all' | 'unread' | AppNotification['category']

export function Notifications() {
  const toast = useToast()
  const list = useResource(() => call('notifications:list'), [])
  const [filter, setFilter] = useState<Filter>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const [marking, setMarking] = useState(false)
  useEvent('notifications:changed', () => void list.reload())

  const items = (list.data ?? []).filter((n) => (filter === 'all' ? true : filter === 'unread' ? !n.readAt : n.category === filter))
  const unread = (list.data ?? []).filter((n) => !n.readAt).length

  const markRead = async (ids: string[] | 'all') => {
    setMarking(true)
    try {
      await call('notifications:markRead', { ids })
      await list.reload()
    } catch (err) {
      toast({ tone: 'bad', title: 'Could not update notifications', body: errorMessage(err) })
    } finally {
      setMarking(false)
    }
  }

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <Panel
        title="Inbox"
        actions={
          <>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'unread', label: `Unread${unread ? ` (${unread})` : ''}` },
                { value: 'subscription', label: 'Subscription' },
                { value: 'trading', label: 'Trading' },
                { value: 'update', label: 'Updates' },
                { value: 'security', label: 'Security' }
              ]}
            />
            <Button size="sm" icon="check" onClick={() => markRead('all')} loading={marking} disabled={!unread}>Mark all read</Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmClear(true)} disabled={!list.data?.some((n) => n.readAt)}>Clear read</Button>
          </>
        }
        flush
      >
        {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data ? (
          <div className="panel-body" style={{ display: 'grid', gap: 12 }}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={34} />)}</div>
        ) : items.length === 0 ? (
          <Empty icon="bell" title={filter === 'all' ? 'No notifications' : 'Nothing here'}>
            Payment decisions, update notices and paper-trade fills appear here.
          </Empty>
        ) : (
          items.map((n) => (
            <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`}>
              <Icon name={SEVERITY[n.severity].icon} style={{ color: SEVERITY[n.severity].color, marginTop: 2 }} />
              <div>
                <div className="n-title">{n.title}</div>
                <div className="n-body">{n.body}</div>
                <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>{n.category} · {dateTime(n.createdAt)}</div>
              </div>
              <div style={{ display: 'grid', justifyItems: 'end', gap: 6 }}>
                <span className="n-time">{ago(n.createdAt)}</span>
                {!n.readAt && <Button size="sm" variant="ghost" onClick={() => markRead([n.id])}>Mark read</Button>}
              </div>
            </div>
          ))
        )}
      </Panel>
      {confirmClear && (
        <ConfirmDialog
          title="Clear read notifications?"
          confirmLabel="Clear"
          onClose={() => setConfirmClear(false)}
          onConfirm={async () => {
            try {
              await call('notifications:clear')
              await list.reload()
              toast({ tone: 'ok', title: 'Read notifications cleared' })
            } catch (err) {
              toast({ tone: 'bad', title: 'Could not clear', body: errorMessage(err) })
              throw err
            }
          }}
        >
          Read notifications are removed from the inbox. Unread ones stay.
        </ConfirmDialog>
      )}
    </div>
  )
}
