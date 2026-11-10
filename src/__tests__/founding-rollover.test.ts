import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// When the founding price ends decides what every founding subscriber is
// charged, so each rule gets its own case: per-account windows roll at the
// first renewal on or after the window's end; legacy (launch-wide) ones keep
// the old "first invoice after the window closes" timing.

const scheduleCreate = vi.fn();
const scheduleUpdate = vi.fn();
const scheduleRetrieve = vi.fn();
const scheduleRelease = vi.fn();
const subscriptionRetrieve = vi.fn();

vi.mock('../lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stripe')>()),
  stripe: () => ({
    subscriptions: { retrieve: subscriptionRetrieve },
    subscriptionSchedules: {
      create: scheduleCreate,
      update: scheduleUpdate,
      retrieve: scheduleRetrieve,
      release: scheduleRelease,
    },
  }),
}));

const BASE_ENV = { ...process.env };
const NOW = new Date('2026-11-09T00:00:00Z');
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// The legacy launch window is 2027-01-14 throughout; tests move the clock.
async function load() {
  vi.resetModules();
  process.env = {
    ...BASE_ENV,
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_monthly',
    STRIPE_PRICE_PLUS_ANNUAL: 'price_annual',
    STRIPE_PRICE_PLUS_MONTHLY_FOUNDING: 'price_monthly_founding',
    STRIPE_PRICE_PLUS_ANNUAL_FOUNDING: 'price_annual_founding',
    FOUNDING_OFFER_ENDS_AT: '2027-01-14T00:00:00Z',
  };
  return (await import('../services/subscriptions/schedules.service')).schedulesService;
}

function subscription(opts: {
  priceId?: string;
  periodEnd: string;
  foundingEndsAt?: string;
  schedule?: string | null;
}) {
  return {
    id: 'sub_1',
    schedule: opts.schedule ?? null,
    metadata: {
      userId: '7',
      ...(opts.foundingEndsAt && { foundingEndsAt: opts.foundingEndsAt }),
    },
    items: {
      data: [{ current_period_end: sec(opts.periodEnd), price: { id: opts.priceId ?? 'price_monthly_founding' } }],
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  for (const m of [scheduleCreate, scheduleUpdate, scheduleRetrieve, scheduleRelease, subscriptionRetrieve]) {
    m.mockReset();
  }
  scheduleCreate.mockResolvedValue({ id: 'sub_sched_1', phases: [{ start_date: 1, end_date: 2 }] });
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...BASE_ENV };
});

describe('scheduleFoundingRollover — per-account window', () => {
  // Founding is one billing period: the very next renewal is standard, even
  // when it still falls inside the account's founding window.
  it('rolls at the next renewal even inside the window', async () => {
    const service = await load();
    await service.scheduleFoundingRollover(
      subscription({ periodEnd: '2026-12-09T00:00:00Z', foundingEndsAt: '2027-01-01T00:00:00Z' }) as never,
      7,
    );
    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: 'sub_1' });
  });

  it('rolls at the first renewal on or after the window end, keeping metadata on every phase', async () => {
    const service = await load();
    await service.scheduleFoundingRollover(
      subscription({ periodEnd: '2027-01-01T00:00:00Z', foundingEndsAt: '2027-01-01T00:00:00Z' }) as never,
      7,
    );

    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: 'sub_1' });
    const { phases } = scheduleUpdate.mock.calls[0][1];
    expect(phases.map((p: { items: { price: string }[] }) => p.items[0].price)).toEqual([
      'price_monthly_founding',
      'price_monthly',
    ]);
    for (const phase of phases) {
      expect(phase.metadata).toEqual({ userId: '7', foundingEndsAt: '2027-01-01T00:00:00Z' });
    }
  });

  it('leaves a pending change alone', async () => {
    scheduleRetrieve.mockResolvedValue({ phases: [{ start_date: sec('2026-11-01T00:00:00Z') }, { start_date: sec('2026-12-09T00:00:00Z') }] });
    const service = await load();
    await service.scheduleFoundingRollover(
      subscription({ periodEnd: '2026-12-09T00:00:00Z', foundingEndsAt: '2026-12-01T00:00:00Z', schedule: 'sub_sched_0' }) as never,
      7,
    );
    expect(scheduleRelease).not.toHaveBeenCalled();
    expect(scheduleCreate).not.toHaveBeenCalled();
  });

  // A plan change onto a founding price leaves a schedule whose last phase is
  // running and never ends — it has to be replaced by a rollover.
  it('replaces a finished plan-change schedule with the rollover', async () => {
    scheduleRetrieve.mockResolvedValue({ phases: [{ start_date: sec('2026-10-01T00:00:00Z') }, { start_date: sec('2026-11-01T00:00:00Z') }] });
    const service = await load();
    await service.scheduleFoundingRollover(
      subscription({
        priceId: 'price_annual_founding',
        periodEnd: '2027-11-01T00:00:00Z',
        foundingEndsAt: '2026-12-01T00:00:00Z',
        schedule: 'sub_sched_0',
      }) as never,
      7,
    );
    expect(scheduleRelease).toHaveBeenCalledWith('sub_sched_0');
    expect(scheduleCreate).toHaveBeenCalled();
  });
});

describe('scheduleFoundingRollover — legacy launch window', () => {
  // Existing founding members move to standard at their next renewal too.
  it('rolls at the next renewal while the launch window is still open', async () => {
    const service = await load();
    await service.scheduleFoundingRollover(subscription({ periodEnd: '2027-01-20T00:00:00Z' }) as never, 7);
    expect(scheduleCreate).toHaveBeenCalled();
  });

  it('rolls on the first invoice after the launch window closes', async () => {
    vi.setSystemTime(new Date('2027-01-20T00:00:00Z'));
    const service = await load();
    await service.scheduleFoundingRollover(subscription({ periodEnd: '2027-02-20T00:00:00Z' }) as never, 7);
    expect(scheduleCreate).toHaveBeenCalled();
  });
});

describe('schedulePlanChange target price', () => {
  async function targetFor(sub: ReturnType<typeof subscription>) {
    subscriptionRetrieve.mockResolvedValue(sub);
    const service = await load();
    await service.schedulePlanChange('sub_1', 7, 'annual');
    const { phases } = scheduleUpdate.mock.calls[0][1];
    return phases[phases.length - 1].items[0].price;
  }

  // A change lands at a renewal, which is after the one founding period.
  it('bills standard even when the change lands inside the window', async () => {
    expect(
      await targetFor(subscription({ periodEnd: '2026-12-09T00:00:00Z', foundingEndsAt: '2027-01-01T00:00:00Z' })),
    ).toBe('price_annual');
  });

  it('bills standard when the change lands after the window', async () => {
    expect(
      await targetFor(subscription({ periodEnd: '2027-01-09T00:00:00Z', foundingEndsAt: '2027-01-01T00:00:00Z' })),
    ).toBe('price_annual');
  });

  it('never grants founding to a subscriber on a standard price', async () => {
    expect(
      await targetFor(
        subscription({ priceId: 'price_monthly', periodEnd: '2026-12-09T00:00:00Z', foundingEndsAt: '2027-01-01T00:00:00Z' }),
      ),
    ).toBe('price_annual');
  });

  it('bills standard for legacy subscriptions too', async () => {
    expect(await targetFor(subscription({ periodEnd: '2027-02-09T00:00:00Z' }))).toBe('price_annual');
  });
});
