/**
 * MetaTrader 5 trade server return codes (MQL5 TRADE_RETCODE_*), with plain-language messages.
 * `unknown: true` means the order may or may not have executed, so the app must reconcile by
 * magic number and comment instead of treating it as rejected (and never re-sends it).
 */
export interface RetcodeInfo {
  name: string
  message: string
  ok?: boolean
  unknown?: boolean
}

export const RETCODES: Record<number, RetcodeInfo> = {
  10004: { name: 'REQUOTE', message: 'The broker requoted the price; nothing was executed.' },
  10006: { name: 'REJECT', message: 'The broker rejected the request.' },
  10007: { name: 'CANCEL', message: 'The request was canceled by the trader.' },
  10008: { name: 'PLACED', message: 'Order placed.', ok: true },
  10009: { name: 'DONE', message: 'Request completed.', ok: true },
  10010: { name: 'DONE_PARTIAL', message: 'Only part of the request was completed.', ok: true },
  10011: { name: 'ERROR', message: 'Request processing error at the broker.', unknown: true },
  // documented as canceled, but a timeout is the one result where checking costs nothing and guessing could
  10012: { name: 'TIMEOUT', message: 'The request timed out at the broker; checking whether it executed.', unknown: true },
  10013: { name: 'INVALID', message: 'Invalid request.' },
  10014: { name: 'INVALID_VOLUME', message: 'Invalid volume for this symbol (check the lot step, minimum and maximum).' },
  10015: { name: 'INVALID_PRICE', message: 'Invalid price in the request.' },
  10016: { name: 'INVALID_STOPS', message: 'Invalid stop-loss or take-profit (too close to the market price or on the wrong side).' },
  10017: { name: 'TRADE_DISABLED', message: 'Trading is disabled for this account or symbol.' },
  10018: { name: 'MARKET_CLOSED', message: 'The market is closed.' },
  10019: { name: 'NO_MONEY', message: 'Not enough free margin for this order.' },
  10020: { name: 'PRICE_CHANGED', message: 'The price changed; nothing was executed.' },
  10021: { name: 'PRICE_OFF', message: 'No quotes to process the request; nothing was executed.' },
  10022: { name: 'INVALID_EXPIRATION', message: 'Invalid order expiration.' },
  10023: { name: 'ORDER_CHANGED', message: 'The order state changed.' },
  10024: { name: 'TOO_MANY_REQUESTS', message: 'Too many requests; try again later.' },
  10025: { name: 'NO_CHANGES', message: 'No changes in the request.' },
  10026: { name: 'SERVER_DISABLES_AT', message: 'Algorithmic trading is disabled by the broker for this account.' },
  10027: { name: 'CLIENT_DISABLES_AT', message: 'Algorithmic trading is disabled in the MT5 terminal. Turn on the "Algo Trading" button in the terminal toolbar.' },
  10028: { name: 'LOCKED', message: 'The request is locked for processing.' },
  10029: { name: 'FROZEN', message: 'The order or position is frozen (too close to the market price).' },
  10030: { name: 'INVALID_FILL', message: 'The order filling type is not supported for this symbol.' },
  10031: { name: 'CONNECTION', message: 'No connection to the trade server.', unknown: true },
  10032: { name: 'ONLY_REAL', message: 'This operation is allowed only on real accounts.' },
  10033: { name: 'LIMIT_ORDERS', message: 'The broker\'s limit on pending orders was reached.' },
  10034: { name: 'LIMIT_VOLUME', message: 'The broker\'s volume limit for this symbol was reached.' },
  10035: { name: 'INVALID_ORDER', message: 'Incorrect or prohibited order type.' },
  10036: { name: 'POSITION_CLOSED', message: 'The position was already closed.' },
  10038: { name: 'INVALID_CLOSE_VOLUME', message: 'The close volume exceeds the position volume.' },
  10039: { name: 'CLOSE_ORDER_EXIST', message: 'A close order already exists for this position.' },
  10040: { name: 'LIMIT_POSITIONS', message: 'The broker\'s limit on open positions was reached.' },
  10041: { name: 'REJECT_CANCEL', message: 'The pending order activation was rejected and canceled.' },
  10042: { name: 'LONG_ONLY', message: 'Only long positions are allowed for this symbol.' },
  10043: { name: 'SHORT_ONLY', message: 'Only short positions are allowed for this symbol.' },
  10044: { name: 'CLOSE_ONLY', message: 'Only closing existing positions is allowed for this symbol.' },
  10045: { name: 'FIFO_CLOSE', message: 'Positions must be closed in FIFO order at this broker.' },
  10046: { name: 'HEDGE_PROHIBITED', message: 'Opposite positions on one symbol are not allowed for this account.' }
}

export function describeRetcode(retcode: number, comment?: string): RetcodeInfo {
  const known = RETCODES[retcode]
  const extra = comment && !/^(Request executed|Done)/i.test(comment) ? ` Broker comment: ${comment}.` : ''
  if (known) return { ...known, message: `${known.message}${extra} (MT5 ${retcode} ${known.name})` }
  return { name: 'UNKNOWN', message: `Unrecognised MT5 result ${retcode}.${extra}`, unknown: true }
}
