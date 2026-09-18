import { describe, it, expect } from 'vitest';
import { decideMembershipAction, type ViewerStanding } from '../services/groups.service';
import type { GroupMembershipStatus } from '../db/schema';

// These are the rules that decide who can see, join and leave a group. They are
// pure precisely so they can be pinned here: there are 24 combinations (three
// actions x four standings x two privacies) and a wrong answer in any of them is
// either a privacy leak or a member trapped in a group.
//
// The status codes are asserted, not just the allow/deny, because the split
// between 403 and 404 here is deliberate and easy to "tidy" into being wrong.

const standing = (
  privacy: 'public' | 'private',
  status: GroupMembershipStatus | null,
  isOwner = false,
): ViewerStanding => ({ privacy, status, isOwner });

const owner = (privacy: 'public' | 'private') => standing(privacy, 'active', true);
const member = (privacy: 'public' | 'private') => standing(privacy, 'active');
const invited = (privacy: 'public' | 'private') => standing(privacy, 'invited');
const stranger = (privacy: 'public' | 'private') => standing(privacy, null);

const code = (d: ReturnType<typeof decideMembershipAction>) =>
  d.allowed ? 200 : d.statusCode;

describe('viewing the member list', () => {
  it('is open to anyone on a public group', () => {
    for (const s of [owner('public'), member('public'), invited('public'), stranger('public')]) {
      expect(code(decideMembershipAction('view_members', s))).toBe(200);
    }
  });

  it('is members-only on a private group', () => {
    expect(code(decideMembershipAction('view_members', owner('private')))).toBe(200);
    expect(code(decideMembershipAction('view_members', member('private')))).toBe(200);
    expect(code(decideMembershipAction('view_members', stranger('private')))).toBe(403);
  });

  it('refuses with 403, not 404, so it never denies the group exists', () => {
    // A private group is unjoinable, not secret — the design shows non-members
    // its name, owner and description. A 404 here would contradict the screen
    // they are already looking at.
    expect(code(decideMembershipAction('view_members', stranger('private')))).toBe(403);
  });

  it('does not treat an invitee to a private group as a member yet', () => {
    // They can see the group and the "you need an invite" state; the roster is
    // still behind accepting.
    expect(code(decideMembershipAction('view_members', invited('private')))).toBe(403);
  });
});

describe('joining', () => {
  it('is allowed for a stranger to a public group', () => {
    expect(code(decideMembershipAction('join', stranger('public')))).toBe(200);
  });

  it('is refused on a private group', () => {
    expect(code(decideMembershipAction('join', stranger('private')))).toBe(403);
  });

  it('tells an invitee to accept instead of joining', () => {
    // Joining would overwrite the invitation and lose who sent it. The more
    // specific answer has to win over the generic "already involved".
    const d = decideMembershipAction('join', invited('private'));
    expect(code(d)).toBe(409);
    expect(d.allowed === false && d.message).toMatch(/accept the invitation/i);
  });

  it('refuses an existing member or the owner with 409', () => {
    expect(code(decideMembershipAction('join', member('public')))).toBe(409);
    expect(code(decideMembershipAction('join', owner('public')))).toBe(409);
  });

  it('answers "already a member" before "private" for a member of a private group', () => {
    // Telling someone who is already in the group that it is private is a
    // nonsense answer, and would send the client down the invite path.
    const d = decideMembershipAction('join', member('private'));
    expect(code(d)).toBe(409);
    expect(d.allowed === false && d.message).toMatch(/already a member/i);
  });
});

describe('leaving', () => {
  it('is allowed for an ordinary member', () => {
    expect(code(decideMembershipAction('leave', member('public')))).toBe(200);
    expect(code(decideMembershipAction('leave', member('private')))).toBe(200);
  });

  it('refuses the owner, and says what to do instead', () => {
    // The owner leaving would orphan the group, and nothing in the design hands
    // it over. 400 rather than 403: it is not a permission problem.
    const d = decideMembershipAction('leave', owner('public'));
    expect(code(d)).toBe(400);
    expect(d.allowed === false && d.message).toMatch(/delete the group/i);
  });

  it('gives 404 to someone who was never a member', () => {
    expect(code(decideMembershipAction('leave', stranger('public')))).toBe(404);
  });

  it('gives 404 to an invitee — declining is not leaving', () => {
    // An invitee has no membership to give up. Letting this through would
    // delete their invitation through a path that does not decrement anything,
    // which is how a counter starts drifting.
    expect(code(decideMembershipAction('leave', invited('public')))).toBe(404);
  });

  it('ignores a reserved "requested" row', () => {
    // 'requested' exists in the enum but has no code path yet. Until it does, it
    // must not read as membership anywhere.
    expect(code(decideMembershipAction('leave', standing('private', 'requested')))).toBe(404);
    expect(code(decideMembershipAction('join', standing('public', 'requested')))).toBe(200);
  });
});
