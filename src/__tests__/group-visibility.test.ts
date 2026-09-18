import { describe, it, expect } from 'vitest';
import { groupViewerCapabilities } from '../services/groups.service';
import type { GroupMembershipStatus } from '../db/schema';

// groupViewerCapabilities is the security boundary of the Groups feature: every
// group-detail screen renders straight off what it returns, so a wrong answer
// here is a privacy bug rather than a cosmetic one. There are eight meaningful
// combinations (four viewer relationships x two privacies) — more than a
// reviewer can hold in their head while reading the surrounding query, which is
// why the function is pure and pinned here.

const OWNER = 7;
const OTHER = 42;

const group = (privacy: 'public' | 'private') => ({ ownerId: OWNER, privacy });

const caps = (
  privacy: 'public' | 'private',
  status: GroupMembershipStatus | null,
  viewerId: number,
) => groupViewerCapabilities(group(privacy), status, viewerId);

describe('groupViewerCapabilities — membership resolution', () => {
  it('treats the owner as owner even with no membership row', () => {
    // The owner gets an 'active' row at creation, but ownership is the source
    // of truth. If the two ever disagree, the column wins — otherwise a missing
    // row would lock an owner out of their own group.
    expect(caps('private', null, OWNER).membership).toBe('owner');
    expect(caps('private', null, OWNER).canEdit).toBe(true);
  });

  it('distinguishes active members from invitees', () => {
    expect(caps('public', 'active', OTHER).membership).toBe('member');
    expect(caps('public', 'invited', OTHER).membership).toBe('invited');
    expect(caps('public', null, OTHER).membership).toBe('none');
  });

  it('treats a reserved "requested" row as not-yet-a-member', () => {
    // 'requested' ships in the enum but has no code path. If request-to-join is
    // built later, this must stay false until the owner approves — a bug here
    // would make asking to join equivalent to joining.
    expect(caps('private', 'requested', OTHER).membership).toBe('none');
    expect(caps('private', 'requested', OTHER).canSeeMembers).toBe(false);
  });
});

describe('groupViewerCapabilities — what private actually withholds', () => {
  it('hides the member list of a private group from a non-member', () => {
    // Private means unjoinable, not secret: the design deliberately shows a
    // non-member the name, image, description, owner and creation date. The
    // member list is the part that is actually private.
    expect(caps('private', null, OTHER).canSeeMembers).toBe(false);
    expect(caps('public', null, OTHER).canSeeMembers).toBe(true);
  });

  it('lets members of a private group see the member list', () => {
    expect(caps('private', 'active', OTHER).canSeeMembers).toBe(true);
    expect(caps('private', null, OWNER).canSeeMembers).toBe(true);
  });

  it('never offers join on a private group', () => {
    expect(caps('private', null, OTHER).canJoin).toBe(false);
    expect(caps('public', null, OTHER).canJoin).toBe(true);
  });

  it('does not offer join to someone already involved', () => {
    // An invitee accepts rather than joins, and a member joining again would
    // double-count them.
    expect(caps('public', 'invited', OTHER).canJoin).toBe(false);
    expect(caps('public', 'active', OTHER).canJoin).toBe(false);
    expect(caps('public', null, OWNER).canJoin).toBe(false);
  });
});

describe('groupViewerCapabilities — who may invite', () => {
  it('lets a plain member invite, not just the owner', () => {
    // The design puts "+ Invite friends" on the plain-member view. Restricting
    // this to the owner is the easy, wrong reading, and it would leave every
    // private group dependent on one person to grow.
    expect(caps('private', 'active', OTHER).canInvite).toBe(true);
  });

  it('does not let invitees or non-members invite', () => {
    expect(caps('public', 'invited', OTHER).canInvite).toBe(false);
    expect(caps('public', null, OTHER).canInvite).toBe(false);
  });

  it('reserves editing to the owner alone', () => {
    expect(caps('public', 'active', OTHER).canEdit).toBe(false);
    expect(caps('public', null, OWNER).canEdit).toBe(true);
  });
});
