import { isValidEmail } from '@tradepilot/shared'
import { sendSmtp, verifySmtp, type SmtpSettings } from '@tradepilot/shared/smtp'
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './ai/anthropic.js'
import { OpenAiProvider } from './ai/openai.js'
import type { AiModel, AiProvider, AiProviderId, AiSettings, AiUsageTracker } from './ai/provider.js'
import { ConsentStore, E164_DIGITS, WhatsAppClient, type WhatsAppConfig } from './channels/whatsapp.js'
import { DeltaRest } from './delta/rest.js'
import { DELTA_REGIONS, isRegion, regionFromLegacyBaseUrl, type DeltaRegion } from './delta/regions.js'
import { UserError } from './errors.js'
import { v8n, type ActionContext, type IntegrationService, type IntegrationSpec } from './integrations.js'
import type { MarketDataService, MarketSettings } from './marketData.js'
import type { IntegrationId } from '../shared/ipc.js'

export const DEFAULT_OPENAI_MODEL = 'gpt-5'

export interface SpecDeps {
  integrations: () => IntegrationService
  market: () => MarketDataService
  usage: AiUsageTracker
  consents: ConsentStore
  defaultSymbol: () => string
  /** test seam */
  fetchImpl?: typeof fetch
}

export function aiSettings(cfg: Record<string, string>, fallbackModel: string): AiSettings {
  return {
    model: cfg.model || fallbackModel,
    maxOutputTokens: Number(cfg.maxOutputTokens) || 2048,
    timeoutSec: Number(cfg.timeoutSec) || 60,
    dailyRequestLimit: Number(cfg.dailyRequestLimit) || 50,
    dailyTokenLimit: Number(cfg.dailyTokenLimit) || 200_000
  }
}

export function deltaRegion(cfg: Record<string, string>): DeltaRegion {
  return isRegion(cfg.region) ? cfg.region : 'india'
}

export function marketSettings(cfg: Record<string, string>): MarketSettings {
  return {
    useWebSocket: cfg.useWebSocket !== 'false',
    staleAfterSec: Number(cfg.staleAfterSec) || 15,
    pollIntervalSec: Number(cfg.pollIntervalSec) || 10
  }
}

export function smtpSettings(cfg: Record<string, string>, password: string | null): SmtpSettings {
  return {
    host: cfg.host!,
    port: Number(cfg.port),
    secure: cfg.secure === 'true',
    requireTLS: cfg.requireTLS !== 'false',
    user: cfg.username || undefined,
    password: password ?? undefined,
    from: cfg.from!
  }
}

/** Phase 1 stored Delta's base URL; Phase 2 stores a region id. */
export function migrateIntegrationConfig(id: IntegrationId, values: Record<string, string>): Record<string, string> {
  if (id === 'delta' && !values.region && values.baseUrl) {
    const region = regionFromLegacyBaseUrl(values.baseUrl)
    if (region) return { ...values, region }
  }
  return values
}

const aiFields = (defaultModel: string) => [
  { key: 'model', required: true, default: defaultModel, validate: (s: string) => (/^[A-Za-z0-9._:-]{2,80}$/.test(s) ? null : 'Invalid model id') },
  { key: 'maxOutputTokens', required: true, default: '2048', validate: v8n.intRange(256, 64_000) },
  { key: 'timeoutSec', required: true, default: '60', validate: v8n.intRange(5, 600) },
  { key: 'dailyRequestLimit', required: true, default: '50', validate: v8n.intRange(1, 100_000) },
  { key: 'dailyTokenLimit', required: true, default: '200000', validate: v8n.intRange(1_000, 100_000_000) }
]

function aiSpec(id: AiProviderId, deps: SpecDeps, make: (key: string) => AiProvider, defaultModel: string): IntegrationSpec {
  const refresh = async (ctx: ActionContext) => {
    ctx.progress('Fetching available models…')
    const provider = make(ctx.secret('apiKey')!)
    const models = await provider.listModels()
    deps.integrations().remember(id, 'models', models)
    deps.integrations().remember(id, 'modelsAt', new Date().toISOString())
    return models
  }
  return {
    config: aiFields(defaultModel),
    secrets: [{ key: 'apiKey', required: true }],
    async test(ctx) {
      const models = await refresh(ctx)
      const model = ctx.config.model
      const listed = models.some((m) => m.id === model)
      return `Authenticated. ${models.length} models available; configured model ${model} ${listed ? 'is available' : 'was NOT found for this key — choose another'}.`
    },
    actions: {
      refreshModels: async (ctx) => `${(await refresh(ctx)).length} models loaded.`
    },
    extras: (ctx, details) => ({
      models: (details.models as AiModel[] | undefined) ?? [],
      modelsAt: details.modelsAt ?? null,
      usage: deps.usage.summary(id, aiSettings(ctx.config, defaultModel))
    })
  }
}

export function buildIntegrationSpecs(deps: SpecDeps): Record<IntegrationId, IntegrationSpec> {
  const f = deps.fetchImpl ?? fetch
  const whatsappConfig = (cfg: Record<string, string>): WhatsAppConfig => ({ phoneNumberId: cfg.phoneNumberId!, businessAccountId: cfg.businessAccountId || undefined, apiVersion: cfg.apiVersion! })

  return {
    delta: {
      config: [{ key: 'region', required: true, default: 'india', validate: v8n.oneOf(Object.keys(DELTA_REGIONS), 'Choose a Delta Exchange region') }],
      secrets: [{ key: 'apiKey', required: true }, { key: 'apiSecret', required: true }],
      async test(ctx) {
        const region = deltaRegion(ctx.config)
        const rest = new DeltaRest(region, { apiKey: ctx.secret('apiKey')!, apiSecret: ctx.secret('apiSecret')! }, f)
        ctx.progress('Checking instruments…')
        const products = await rest.products()
        ctx.progress('Verifying signed request…')
        const balances = await rest.balances()
        ctx.progress('Checking order-history permission…')
        let history = 'order history readable'
        try {
          await rest.orderHistory(1)
        } catch (err) {
          history = `order history not readable (${err instanceof Error ? err.message : err})`
        }
        return `Authenticated with ${DELTA_REGIONS[region].label}: ${balances.length} wallet balance${balances.length === 1 ? '' : 's'}, ${products.length} live perpetuals, ${history}. Order placement is disabled in this release.`
      },
      extras: (ctx) => ({ regions: Object.values(DELTA_REGIONS).map((r) => ({ id: r.id, label: r.label })), region: deltaRegion(ctx.config) })
    },

    marketdata: {
      config: [
        { key: 'useWebSocket', required: true, default: 'true', validate: v8n.bool },
        { key: 'staleAfterSec', required: true, default: '15', validate: v8n.intRange(5, 300) },
        { key: 'pollIntervalSec', required: true, default: '10', validate: v8n.intRange(3, 300) }
      ],
      secrets: [],
      async test(ctx) {
        ctx.progress('Loading instruments and opening the live stream…')
        return deps.market().test(deps.defaultSymbol())
      },
      extras: () => ({ health: deps.market().health(), defaultSymbol: deps.defaultSymbol() })
    },

    openai: aiSpec('openai', deps, (key) => new OpenAiProvider(key, f), DEFAULT_OPENAI_MODEL),
    anthropic: aiSpec('anthropic', deps, (key) => new AnthropicProvider(key, deps.fetchImpl), DEFAULT_ANTHROPIC_MODEL),

    smtp: {
      config: [
        { key: 'host', required: true, validate: (v) => (/^[A-Za-z0-9.-]{3,253}$/.test(v) ? null : 'Enter a host name such as smtp.example.com') },
        { key: 'port', required: true, default: '587', validate: v8n.port },
        { key: 'secure', required: true, default: 'false', validate: v8n.bool },
        { key: 'requireTLS', required: true, default: 'true', validate: v8n.bool },
        { key: 'username', required: false },
        { key: 'from', required: true, validate: (v) => (isValidEmail(v.replace(/^.*<([^>]+)>\s*$/, '$1')) ? null : 'Enter a valid sender address') },
        { key: 'testRecipient', required: true, validate: (v) => (isValidEmail(v) ? null : 'Enter a valid email address') },
        { key: 'tradingAlerts', required: true, default: 'false', validate: v8n.bool },
        { key: 'alertRecipient', required: false, validate: (v) => (isValidEmail(v) ? null : 'Enter a valid email address') }
      ],
      secrets: [{ key: 'password', required: false }],
      async test(ctx) {
        ctx.progress('Connecting and authenticating…')
        await verifySmtp(smtpSettings(ctx.config, ctx.secret('password')))
        return `Connected to ${ctx.config.host}:${ctx.config.port} and ${ctx.config.username ? 'authenticated' : 'greeted (no login configured)'}. No email was sent; use "Send test email" for that.`
      },
      actions: {
        sendTest: async (ctx) => {
          ctx.progress(`Sending to ${ctx.config.testRecipient}…`)
          const r = await sendSmtp(smtpSettings(ctx.config, ctx.secret('password')), {
            to: ctx.config.testRecipient!,
            subject: 'TradePilot — test email',
            text: 'This message confirms that TradePilot can send alert emails through your SMTP server.'
          })
          return `Accepted by ${ctx.config.host} for ${r.accepted.join(', ')}${r.rejected.length ? `; rejected: ${r.rejected.join(', ')}` : ''}. Server reply: "${r.response.slice(0, 160)}". Acceptance means queued for delivery, not that it reached the inbox.`
        }
      }
    },

    whatsapp: {
      config: [
        { key: 'phoneNumberId', required: true, validate: (v) => (/^\d{5,25}$/.test(v) ? null : 'The phone number ID is numeric (WhatsApp → API Setup)') },
        { key: 'businessAccountId', required: false, validate: (v) => (/^\d{5,25}$/.test(v) ? null : 'The WhatsApp Business Account ID is numeric') },
        { key: 'apiVersion', required: true, default: 'v23.0', validate: (v) => (/^v\d{1,2}\.\d$/.test(v) ? null : 'Format like v23.0') },
        { key: 'templateName', required: true, default: 'hello_world', validate: (v) => (/^[a-z0-9_]{1,512}$/.test(v) ? null : 'Lower-case letters, digits and underscores') },
        { key: 'templateLanguage', required: true, default: 'en_US', validate: (v) => (/^[a-z]{2,3}(_[A-Z]{2})?$/.test(v) ? null : 'Language code such as en_US') },
        { key: 'tradingAlerts', required: true, default: 'false', validate: v8n.bool },
        { key: 'alertTemplateName', required: false, validate: (v) => (/^[a-z0-9_]{1,512}$/.test(v) ? null : 'Lower-case letters, digits and underscores') },
        { key: 'alertTemplateLanguage', required: false, validate: (v) => (/^[a-z]{2,3}(_[A-Z]{2})?$/.test(v) ? null : 'Language code such as en_US') },
        { key: 'alertRecipient', required: false, validate: (v) => (/^\+?[1-9][\d\s()-]{7,20}$/.test(v) ? null : 'International format, e.g. +91 98765 43210') }
      ],
      secrets: [{ key: 'accessToken', required: true }],
      async test(ctx) {
        const client = new WhatsAppClient(whatsappConfig(ctx.config), ctx.secret('accessToken')!, f)
        ctx.progress('Checking the business phone number…')
        const phone = await client.phoneNumber()
        let templateNote = 'add the Business Account ID to verify templates'
        if (ctx.config.businessAccountId) {
          ctx.progress('Listing message templates…')
          const templates = await client.templates()
          deps.integrations().remember('whatsapp', 'templates', templates)
          const t = templates.find((x) => x.name === ctx.config.templateName && x.language === ctx.config.templateLanguage)
          templateNote = t ? `template "${t.name}" (${t.language}) is ${t.status}` : `template "${ctx.config.templateName}" (${ctx.config.templateLanguage}) was not found`
        }
        return `Credentials valid for ${phone.verified_name ?? 'business'} ${phone.display_phone_number ?? ''}${phone.quality_rating ? `, quality ${phone.quality_rating}` : ''}; ${templateNote}.`
      },
      actions: {
        addConsent: async (_ctx, p) => {
          const c = deps.consents.add(String(p.recipient ?? ''), p.confirmed === true, String(p.note ?? ''))
          return `+${c.recipient} added to the opt-in list.`
        },
        revokeConsent: async (_ctx, p) => {
          deps.consents.revoke(String(p.id ?? ''))
          return 'Recipient removed from the opt-in list.'
        },
        sendTest: async (ctx, p) => {
          const to = String(p.recipient ?? '').replace(/[\s()+-]/g, '')
          if (!E164_DIGITS.test(to)) throw new UserError('validation_failed', 'Choose a recipient from the opt-in list.')
          if (!deps.consents.has(to)) throw new UserError('no_consent', 'This number has not opted in. Add it to the opt-in list first (WhatsApp Business policy).')
          ctx.progress(`Sending template "${ctx.config.templateName}"…`)
          const client = new WhatsAppClient(whatsappConfig(ctx.config), ctx.secret('accessToken')!, f)
          const r = await client.sendTemplate(to, ctx.config.templateName!, ctx.config.templateLanguage!)
          return `Accepted by WhatsApp for +${to} (message ${r.messageId}${r.status ? `, status ${r.status}` : ''}). Delivery and read receipts arrive via webhooks, which are not set up in this release.`
        }
      },
      extras: (_ctx, details) => ({ consents: deps.consents.list(), templates: details.templates ?? [] })
    }
  }
}
