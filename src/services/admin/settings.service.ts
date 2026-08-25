import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { announcementBanners } from '../../db/schema';

/** The two strips the design draws, in the order they stack. */
export const BANNER_SLOTS = ['top', 'second'] as const;
export type BannerSlot = (typeof BANNER_SLOTS)[number];

export interface BannerInput {
  slot: BannerSlot;
  enabled: boolean;
  text: string;
}

export const adminSettingsService = {
  /**
   * Both banners, always both, in stack order.
   *
   * A disabled banner is still returned, with `enabled: false`, because the
   * admin screen needs to render the toggle and its text. The **public**
   * endpoint filters the disabled ones out — a storefront has no business
   * knowing the copy of a banner it is not showing.
   */
  async list() {
    const rows = await db.select().from(announcementBanners);
    const bySlot = new Map(rows.map((r) => [r.slot, r]));

    return BANNER_SLOTS.map((slot) => {
      const row = bySlot.get(slot);
      return {
        slot,
        enabled: row?.enabled ?? false,
        text: row?.text ?? '',
        updatedAt: row?.updatedAt ?? null,
      };
    });
  },

  /** What the storefront reads: enabled banners only. */
  async publicBanners() {
    return (await this.list())
      .filter((b) => b.enabled && b.text.trim().length > 0)
      .map(({ slot, text }) => ({ slot, text }));
  },

  /**
   * Upserts both slots in one transaction.
   *
   * All-or-nothing because the design's Save Changes button saves both, and a
   * partial write would leave the site advertising one banner from before the
   * edit and one from after.
   */
  async update(banners: BannerInput[], adminId: number) {
    await db.transaction(async (tx) => {
      for (const banner of banners) {
        await tx
          .insert(announcementBanners)
          .values({
            slot: banner.slot,
            enabled: banner.enabled,
            text: banner.text,
            updatedBy: adminId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: announcementBanners.slot,
            set: {
              enabled: banner.enabled,
              text: banner.text,
              updatedBy: adminId,
              updatedAt: new Date(),
            },
          });
      }
    });

    return this.list();
  },

  async get(slot: BannerSlot) {
    const [row] = await db
      .select()
      .from(announcementBanners)
      .where(eq(announcementBanners.slot, slot))
      .limit(1);
    return row ?? null;
  },
};
