"""Test double for MetaQuotes' MetaTrader5 package (tests only).

Same function names, keyword arguments, namedtuple results and constant values as the real
package, scripted in memory. It never pretends to be a broker in the app: it is only imported by
tests and by tests/run_fake_mt5_bridge.py.
"""

from collections import namedtuple

__version__ = "fake"

TIMEFRAME_M1, TIMEFRAME_M5, TIMEFRAME_M15, TIMEFRAME_M30, TIMEFRAME_H1, TIMEFRAME_H4, TIMEFRAME_D1 = 1, 5, 15, 30, 16385, 16388, 16408
ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
TRADE_ACTION_DEAL, TRADE_ACTION_SLTP, TRADE_ACTION_REMOVE = 1, 6, 8
ORDER_TIME_GTC = 0
ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE, TRADE_RETCODE_DONE_PARTIAL = 10008, 10009, 10010
DEAL_ENTRY_IN, DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT, DEAL_ENTRY_OUT_BY = 0, 1, 2, 3
DEAL_TYPE_BUY, DEAL_TYPE_SELL = 0, 1
POSITION_TYPE_BUY, POSITION_TYPE_SELL = 0, 1
ORDER_STATE_STARTED, ORDER_STATE_PLACED, ORDER_STATE_CANCELED, ORDER_STATE_PARTIAL, ORDER_STATE_FILLED, ORDER_STATE_REJECTED, ORDER_STATE_EXPIRED = 0, 1, 2, 3, 4, 5, 6
ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2
ACCOUNT_MARGIN_MODE_RETAIL_NETTING, ACCOUNT_MARGIN_MODE_EXCHANGE, ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 0, 1, 2
SYMBOL_TRADE_MODE_DISABLED, SYMBOL_TRADE_MODE_LONGONLY, SYMBOL_TRADE_MODE_SHORTONLY, SYMBOL_TRADE_MODE_CLOSEONLY, SYMBOL_TRADE_MODE_FULL = 0, 1, 2, 3, 4
SYMBOL_FILLING_FOK, SYMBOL_FILLING_IOC = 1, 2

AccountInfo = namedtuple("AccountInfo", "login trade_mode leverage trade_allowed trade_expert margin_mode currency_digits balance equity margin margin_free profit name server currency company")
TerminalInfo = namedtuple("TerminalInfo", "connected trade_allowed tradeapi_disabled build name path company")
SymbolInfo = namedtuple("SymbolInfo", "name description path visible select digits point spread trade_tick_value trade_tick_size trade_contract_size volume_min volume_max volume_step trade_mode trade_stops_level filling_mode currency_base currency_profit currency_margin bid ask time")
Tick = namedtuple("Tick", "time bid ask last volume time_msc flags volume_real")
Rate = namedtuple("Rate", "time open high low close tick_volume spread real_volume")
OrderSendResult = namedtuple("OrderSendResult", "retcode deal order volume price bid ask comment request_id retcode_external")
OrderCheckResult = namedtuple("OrderCheckResult", "retcode balance equity profit margin margin_free margin_level comment")
TradePosition = namedtuple("TradePosition", "ticket time time_msc type magic identifier volume price_open sl tp price_current swap profit symbol comment")
TradeOrder = namedtuple("TradeOrder", "ticket time_setup time_done type state magic position_id volume_initial volume_current price_open symbol comment")
TradeDeal = namedtuple("TradeDeal", "ticket order time time_msc type entry magic position_id volume price commission swap profit fee symbol comment")

PASSWORD = "demo-pass"
state = {}


def reset():
    state.clear()
    state.update(
        initialized=False, last_error=(1, "Success"), sent=[], init_kwargs=None, next_ticket=1000, fail_send=None, retcode=TRADE_RETCODE_DONE,
        positions=[], history_orders=[], history_deals=[], time=1_760_000_000,
        symbols={
            "EURUSD": SymbolInfo("EURUSD", "Euro vs US Dollar", "Forex\\Majors\\EURUSD", True, True, 5, 0.00001, 12, 1.0, 0.00001, 100_000.0, 0.01, 50.0, 0.01, SYMBOL_TRADE_MODE_FULL, 10, SYMBOL_FILLING_IOC, "EUR", "USD", "EUR", 1.08500, 1.08512, 1_760_000_000),
            "USDJPY": SymbolInfo("USDJPY", "US Dollar vs Japanese Yen", "Forex\\Majors\\USDJPY", True, True, 3, 0.001, 15, 0.6667, 0.001, 100_000.0, 0.01, 50.0, 0.01, SYMBOL_TRADE_MODE_FULL, 0, SYMBOL_FILLING_FOK | SYMBOL_FILLING_IOC, "USD", "JPY", "USD", 150.000, 150.015, 1_760_000_000),
        },
    )


reset()


def last_error():
    return state["last_error"]


def initialize(path=None, login=None, password=None, server=None, timeout=None, portable=False):
    state["init_kwargs"] = {"path": path, "login": login, "server": server, "timeout": timeout, "password_given": password is not None}
    if password != PASSWORD:
        state["last_error"] = (-6, "Terminal: Authorization failed")
        return False
    state["initialized"] = True
    return True


def shutdown():
    state["initialized"] = False


def account_info():
    return AccountInfo(51234567, ACCOUNT_TRADE_MODE_DEMO, 100, True, True, ACCOUNT_MARGIN_MODE_RETAIL_HEDGING, 2, 10_000.0, 10_000.0, 0.0, 10_000.0, 0.0, "Demo Trader", "Broker-Demo", "USD", "Example Broker Ltd")


def terminal_info():
    return TerminalInfo(True, True, False, 4410, "MetaTrader 5", "C:\\Program Files\\MetaTrader 5", "Example Broker Ltd")


def symbols_get(group=None):
    return tuple(state["symbols"].values())


def symbol_select(symbol, enable=True):
    return symbol in state["symbols"]


def symbol_info(symbol):
    return state["symbols"].get(symbol)


def symbol_info_tick(symbol):
    s = state["symbols"].get(symbol)
    return None if s is None else Tick(state["time"], s.bid, s.ask, 0.0, 0, state["time"] * 1000, 6, 0.0)


def copy_rates_from_pos(symbol, timeframe, start_pos, count):
    if symbol not in state["symbols"]:
        state["last_error"] = (-4, "Terminal: Not found")
        return None
    step = {TIMEFRAME_M5: 300, TIMEFRAME_M15: 900, TIMEFRAME_H1: 3600, TIMEFRAME_H4: 14400, TIMEFRAME_D1: 86400}[timeframe]
    base = state["symbols"][symbol].bid
    end = state["time"] - state["time"] % step
    return [Rate(end - (count - 1 - i) * step, base, base * 1.001, base * 0.999, base, 100 + i, 12, 0) for i in range(count)]


def order_check(request):
    return OrderCheckResult(0, 10_000.0, 10_000.0, 0.0, 100.0, 9_900.0, 10_000.0, "Done")


def order_send(request):
    state["sent"].append(dict(request))
    if state["fail_send"]:
        state["last_error"] = state["fail_send"]
        return None
    state["next_ticket"] += 1
    t = state["next_ticket"]
    s = state["symbols"][request["symbol"]]
    price = s.ask if request.get("type") == ORDER_TYPE_BUY else s.bid
    return OrderSendResult(state["retcode"], t + 5000, t, request.get("volume", 0.0), price, s.bid, s.ask, "Request executed", 7, 0)


def positions_get(symbol=None, ticket=None, group=None):
    rows = state["positions"]
    if symbol is not None:
        rows = [p for p in rows if p.symbol == symbol]
    if ticket is not None:
        rows = [p for p in rows if p.ticket == ticket]
    return tuple(rows)


def orders_get(symbol=None, group=None):
    return ()


def history_orders_get(date_from=None, date_to=None, ticket=None, position=None, group=None):
    rows = state["history_orders"]
    if ticket is not None:
        rows = [o for o in rows if o.ticket == ticket]
    return tuple(rows)


def history_deals_get(date_from=None, date_to=None, ticket=None, position=None, group=None):
    rows = state["history_deals"]
    if ticket is not None:
        rows = [d for d in rows if d.ticket == ticket]
    if position is not None:
        rows = [d for d in rows if d.position_id == position]
    return tuple(rows)
