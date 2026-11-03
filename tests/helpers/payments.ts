import crypto from "node:crypto";
import Stripe from "stripe";
import type { Alerts, Deps, Mailer } from "@/lib/payments/ports";
import type { Rpc } from "@/lib/payments/rpc";
import { loadStripeConfig } from "@/lib/payments/config";
import type { TestDb } from "./db";

/** Same function names as production, run against the real local Postgres. */
export function pgRpc(db: TestDb): Rpc {
  return async <T>(fn: string, args: Record<string, unknown> = {}) => {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    const r = await db.pool.query(`select public.${fn}(${named}) as r`, keys.map((k) => args[k]));
    return r.rows[0].r as T;
  };
}

export class RecordingMailer {
  sent: Array<{ template: string; args: any }> = [];
  of(t: string) { return this.sent.filter((s) => s.template === t).map((s) => s.args); }
  asMailer(): Mailer {
    return new Proxy({} as Mailer, { get: (_t, template: string) => async (args: unknown) => { this.sent.push({ template, args }); } });
  }
}
export class RecordingAlerts {
  alerts: Array<{ subject: string; details?: unknown }> = [];
  asAlerts(): Alerts { return { notify: async (subject, details) => { this.alerts.push({ subject, details }); } }; }
}

export const TEST_ENV = {
  STRIPE_SECRET_KEY: "sk_test_dummy123",
  STRIPE_WEBHOOK_SECRET: "whsec_testsecret",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_dummy123",
  PLATFORM_FEE_BPS: "300",
  PLATFORM_FEE_FIXED_CENTS: "0",
  NEXT_PUBLIC_SITE_URL: "https://bybrick.test",
};

const realStripe = new Stripe("sk_test_dummy123"); // never makes a network call here

interface Call { fn: string; params: any; opts: any }

/** In-memory stand-in for the parts of Stripe the app uses. Records every call. */
export function makeFakeStripe() {
  let n = 0;
  const id = (p: string) => `${p}_${(++n).toString().padStart(4, "0")}${crypto.randomBytes(3).toString("hex")}`;
  const calls: Call[] = [];
  const rec = (fn: string, params: any, opts: any) => calls.push({ fn, params, opts });
  const customers = new Map<string, any>();
  const setupIntents = new Map<string, any>();
  const paymentIntents = new Map<string, any>();
  const detached: Array<{ pm: string; account: string }> = [];
  const domains: Array<{ domain: string; account: string }> = [];
  const accounts = new Map<string, any>();
  const notFound = (what: string) => new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: `No such ${what}` } as any);

  const state = {
    /** What the next PaymentIntent create does. */
    nextCharge: { kind: "success" } as { kind: "success" } | { kind: "decline"; code: string } | { kind: "auth_required" } | { kind: "processing" } | { kind: "network" },
    accountCardPaymentsStatus: "active",
    domainCreateFails: false,
  };

  const stripe = {
    customers: {
      create: async (params: any, opts: any) => {
        rec("customers.create", params, opts);
        const c = { id: id("cus"), name: params.name, email: params.email, deleted: false, account: opts.stripeAccount };
        customers.set(c.id, c); return c;
      },
      retrieve: async (cid: string, params: any, opts: any) => {
        rec("customers.retrieve", params, opts);
        const c = customers.get(cid);
        if (!c || c.account !== opts.stripeAccount) throw notFound("customer");
        return c;
      },
    },
    setupIntents: {
      create: async (params: any, opts: any) => {
        rec("setupIntents.create", params, opts);
        const si = { id: id("seti"), client_secret: id("seti_secret"), status: "requires_payment_method", customer: params.customer, metadata: params.metadata, payment_method: null, account: opts.stripeAccount };
        setupIntents.set(si.id, si); return si;
      },
      retrieve: async (sid: string, params: any, opts: any) => {
        rec("setupIntents.retrieve", params, opts);
        const si = setupIntents.get(sid);
        if (!si || si.account !== opts.stripeAccount) throw notFound("setupintent");
        return si;
      },
    },
    paymentIntents: {
      create: async (params: any, opts: any) => {
        rec("paymentIntents.create", params, opts);
        const b = state.nextCharge;
        state.nextCharge = { kind: "success" };
        if (b.kind === "network") throw new Stripe.errors.StripeConnectionError({ type: "api_error", message: "connection reset" } as any);
        const pi: any = { id: id("pi"), amount: params.amount, amount_received: 0, application_fee_amount: params.application_fee_amount ?? null, metadata: params.metadata, status: "succeeded", account: opts.stripeAccount, last_payment_error: null };
        if (b.kind === "success") pi.amount_received = params.amount;
        paymentIntents.set(pi.id, pi);
        if (b.kind === "decline") throw new Stripe.errors.StripeCardError({ type: "card_error", code: b.code, message: "declined", payment_intent: { id: pi.id } } as any);
        if (b.kind === "auth_required") throw new Stripe.errors.StripeCardError({ type: "card_error", code: "authentication_required", message: "auth", payment_intent: { id: pi.id } } as any);
        if (b.kind === "processing") pi.status = "processing";
        return pi;
      },
      retrieve: async (pid: string, params: any, opts: any) => {
        rec("paymentIntents.retrieve", params, opts);
        const pi = paymentIntents.get(pid);
        if (!pi || pi.account !== opts.stripeAccount) throw notFound("payment_intent");
        return { ...pi, latest_charge: { balance_transaction: { fee_details: [
          { type: "stripe_fee", amount: 320 }, { type: "application_fee", amount: pi.application_fee_amount ?? 0 },
        ] } } };
      },
    },
    paymentMethods: {
      detach: async (pm: string, params: any, opts: any) => { rec("paymentMethods.detach", params, opts); detached.push({ pm, account: opts.stripeAccount }); return {}; },
    },
    paymentMethodDomains: {
      create: async (params: any, opts: any) => {
        rec("paymentMethodDomains.create", params, opts);
        if (state.domainCreateFails) throw new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "already exists" } as any);
        domains.push({ domain: params.domain_name, account: opts.stripeAccount }); return {};
      },
      list: async (params: any, opts: any) => {
        rec("paymentMethodDomains.list", params, opts);
        return { data: domains.filter((d) => d.account === opts.stripeAccount && d.domain === params.domain_name) };
      },
    },
    v2: { core: {
      accounts: {
        create: async (params: any, opts: any) => {
          rec("v2.accounts.create", params, opts);
          const key = opts?.idempotencyKey;
          const existing = [...accounts.values()].find((a) => a.key === key);
          if (existing) return existing;
          const a = { id: id("acct"), key, params }; accounts.set(a.id, a); return a;
        },
        retrieve: async (aid: string, params: any) => {
          rec("v2.accounts.retrieve", params, {});
          return { id: aid, configuration: { merchant: { capabilities: { card_payments: { status: state.accountCardPaymentsStatus } } } } };
        },
      },
      accountLinks: { create: async (params: any) => { rec("v2.accountLinks.create", params, {}); return { url: `https://connect.stripe.test/onboard/${params.account}` }; } },
    } },
    webhooks: realStripe.webhooks,
  };

  return {
    stripe: stripe as unknown as Stripe, calls, state, detached, domains, setupIntents, paymentIntents, customers,
    callsTo: (fn: string) => calls.filter((c) => c.fn === fn),
    /** Simulate the browser finishing the Payment Element: the card is saved. */
    completeSetup(siId: string, pm = id("pm")) {
      const si = setupIntents.get(siId); si.status = "succeeded"; si.payment_method = pm; return pm;
    },
  };
}
export type FakeStripe = ReturnType<typeof makeFakeStripe>;

export function makeDeps(db: TestDb, fake: FakeStripe, over: Partial<Deps> = {}) {
  const mailer = new RecordingMailer();
  const alerts = new RecordingAlerts();
  const turnstile = { ok: true };
  const deps: Deps = {
    stripe: fake.stripe,
    rpc: pgRpc(db),
    cfg: loadStripeConfig(TEST_ENV),
    mailer: mailer.asMailer(),
    alerts: alerts.asAlerts(),
    turnstileSecret: "ts_secret",
    limiterSecret: "x".repeat(40),
    fetch: (async () => new Response(JSON.stringify({ success: turnstile.ok }), { status: 200 })) as typeof fetch,
    ...over,
  };
  return { deps, mailer, alerts, turnstile };
}

/** A payload and Stripe-Signature header, signed the way Stripe signs. */
export function signedEvent(type: string, object: any, o: { account?: string; livemode?: boolean; created?: number; id?: string; secret?: string } = {}) {
  const event = {
    id: o.id ?? "evt_" + crypto.randomBytes(8).toString("hex"), object: "event", type,
    livemode: o.livemode ?? false, created: o.created ?? Math.floor(Date.now() / 1000),
    ...(o.account ? { account: o.account } : {}), data: { object }, api_version: "2026-10-28",
  };
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: o.secret ?? TEST_ENV.STRIPE_WEBHOOK_SECRET, timestamp: o.created });
  return { event, payload, header };
}
