import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  decideMembershipAction,
  friendOfCondition,
  buildFriendNameCondition,
  type ViewerStanding,
} from '../services/groups.service';
import type { GroupMembershipStatus } from '../db/schema';

// Invitations are the only way into a private group, so the rules about who may
// send one and who may act on one are the whole access-control story for private
// clubs. These pin them, plus the friendship query the picker is built on —
// getting that condition wrong would either hide real friends or expose
// strangers as invitable.

const dialect = new PgDialect();
const standing = (
  privacy: 'public' | 'private',
  status: GroupMembershipStatus | null,
  isOwner = false,
): ViewerStanding => ({ privacy, status, isOwner });

const code = (d: ReturnType<typeof decideMembershipAction>) => (d.allowed ? 200 : d.statusCode);

describe('who may invite', () => {
  it('allows any member, not only the owner', () => {
    // The design puts "+ Invite friends" on the plain-member view. Restricting
    // this to the owner would leave every private group depending on one person
    // to grow, and is the easy wrong reading.
    expect(code(decideMembershipAction('invite', standing('private', 'active')))).toBe(200);
    expect(code(decideMembershipAction('invite', standing('private', 'active', true)))).toBe(200);
  });

  it('refuses an invitee who has not accepted yet', () => {
    // Otherwise an invitation is transitively a membership: one person let in
    // could populate a private group before deciding to join it themselves.
    expect(code(decideMembershipAction('invite', standing('private', 'invited')))).toBe(403);
  });

  it('refuses a non-member of a public group', () => {
    // Public means anyone may join, not that anyone may pull others in.
    expect(code(decideMembershipAction('invite', standing('public', null)))).toBe(403);
  });
});

describe('acting on an invitation', () => {
  it('is allowed only with an invitation outstanding', () => {
    expect(code(decideMembershipAction('accept_invite', standing('private', 'invited')))).toBe(200);
    expect(code(decideMembershipAction('decline_invite', standing('private', 'invited')))).toBe(200);
  });

  it('gives 404 to a member, a stranger and a reserved request row alike', () => {
    // The answer must not distinguish "never invited" from "already handled" —
    // a different code for each would report whether an invitation once existed.
    for (const s of [
      standing('private', 'active'),
      standing('private', null),
      standing('private', 'requested'),
      standing('public', 'active', true),
    ]) {
      expect(code(decideMembershipAction('accept_invite', s))).toBe(404);
      expect(code(decideMembershipAction('decline_invite', s))).toBe(404);
    }
  });

  it('does not let an invitee join around their invitation', () => {
    // Joining over an invitation would drop invited_by, the one thing the
    // invitation carries, so join sends them to accept instead.
    const d = decideMembershipAction('join', standing('public', 'invited'));
    expect(code(d)).toBe(409);
    expect(d.allowed === false && d.message).toMatch(/accept the invitation/i);
  });
});

describe('the friendship condition behind the picker', () => {
  const sql = () => dialect.sqlToQuery(friendOfCondition(7)).sql;

  it('matches an accepted follow in either direction', () => {
    // A profile counts friends both ways. Matching only people the viewer
    // follows would hide anyone who followed them first, which is not how
    // "Invite your friends" reads. The two directions are the two arms of the
    // union: one keyed on sender_id, one on receiver_id.
    const compiled = sql();
    expect(compiled).toMatch(/union/i);
    expect(compiled).toMatch(/sender_id/);
    expect(compiled).toMatch(/receiver_id/);
  });

  it('counts only accepted follows', () => {
    // A pending request is not a friendship; inviting off one would let someone
    // reach a stranger by requesting to follow them first. Both arms must say so
    // — filtering only one would leak half the graph.
    const compiled = sql();
    expect(compiled.match(/accepted/g)?.length).toBe(2);
  });

  it('joins on a key rather than filtering on a two-column OR', () => {
    // This is the property the query was rewritten for. The obvious form —
    // EXISTS (sender = v AND receiver = u.id OR receiver = v AND sender = u.id)
    // — spans two columns, so the planner cannot use it as a join key and
    // degrades to a join filter, re-testing the viewer's follows against every
    // candidate user. Split into a union, each arm is an indexed lookup and the
    // result is an equijoin on users.id, bounded by the viewer's friend count.
    const compiled = sql();
    expect(compiled).not.toMatch(/\bor\b/i);
    expect(compiled).toMatch(/"users"\."id" in/i);
  });

  it('cannot return a mutual friend twice', () => {
    // Someone who follows you and is followed back appears in both arms. `IN`
    // is a semi-join so the outer row is returned once regardless, and the
    // UNION (not UNION ALL) dedupes the inner set as well.
    const compiled = sql();
    expect(compiled).not.toMatch(/union\s+all/i);
  });
});

describe('the picker search box', () => {
  const compiled = (q: string) => dialect.sqlToQuery(buildFriendNameCondition(q)).sql;

  it('matches on a prefix or a word prefix only', () => {
    // Deliberately narrower than group discovery search: this filters a list the
    // viewer already knows, where typing "th" should narrow to Theo rather than
    // fuzzily rank people whose names merely resemble it.
    const sql = compiled('the');
    expect(sql).toMatch(/ilike/i);
    expect(sql).not.toMatch(/word_similarity/);
    expect(sql).not.toMatch(/plainto_tsquery/);
  });

  it('parameterises the term rather than inlining it', () => {
    expect(compiled("th'); drop table users;--")).not.toContain('drop table');
  });
});
