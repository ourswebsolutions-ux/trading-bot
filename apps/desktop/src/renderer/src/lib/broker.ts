import { BROKER_LABEL, type BrokerId } from '@shared/ipc'
import { useApp } from './state'

/** The active broker (Settings → General): market data, account view and new strategies use it. */
export function useBroker() {
  const { prefs } = useApp()
  const broker: BrokerId = prefs?.broker ?? 'delta'
  return {
    broker,
    label: BROKER_LABEL[broker],
    isMt5: broker === 'mt5',
    defaultSymbol: broker === 'mt5' ? prefs?.defaultSymbolMt5 || 'EURUSD' : prefs?.defaultSymbol || 'BTCUSD',
    /** Preference key that stores this broker's default symbol. */
    defaultSymbolKey: broker === 'mt5' ? ('defaultSymbolMt5' as const) : ('defaultSymbol' as const)
  }
}
