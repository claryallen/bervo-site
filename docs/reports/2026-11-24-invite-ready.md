# CR-INVITEREADY.1: "ready in 2–3 days" checkbox on bervo.ai/invite

Branch `invite-ready` (worktree `~/local-ai/invite-ready-wt`), off bervo-site main `1858ed3`. Spec: daily-dashboard `docs/marketing/copy/invite_ready_checkbox.md`.

## 1. Built

- **Form (`invite.html`)**: an optional, unchecked checkbox inside `#fs-plan`, right after the two plan panels and before "How did you hear about Bervo?". Real `<label class="check ready-soon" for="ready_soon">`; the words are the spec's, character for character, with the en dash in "2–3". No new colors (it inherits the page's theme tokens), no script change.
- **Storage**: new D1 column `ready_soon` (migration `functions/_dev/migrations/0013_ready_soon.sql`). 0012 is the unapplied newsletter (on its own branch), so this is 0013. One line, no comments. `INTEGER DEFAULT 0`, only 0, 1 or NULL accepted. The handler (`_lib/invites.js` `validateInvite` + `insertInvite`) writes 1 only when the box is ticked. If the column is missing it stores the request without it, so submissions work before and after the migration. Any other database error still ends in the "retry" page.
- **Admin invites page (`functions/admin/invites.js`)**: a "Ready in 2–3 days" flag on each flagged request (summary line, a "Ready" row in the answers, and the compact row in the collapsed tabs). In every tab, flagged requests come first (newest first), then the rest as before. The flag reuses the page's amber tokens: 8.0:1 light, 10.1:1 dark (computed). It is one short non-wrapping pill, so the 320px layout is unchanged. Before the migration the page shows no flag and sorts as today.
- **Trim**: Mark onboarded erases the answer in the same batch. It is **not in `TRIMMED_COLUMNS`** on purpose: `TRIM_SET` is also used before the migration, and a missing column would break every Mark onboarded. Instead `ONBOARD_ERASE_READY` is the newest, first-tried form in `onboardBatch`, which steps down on "no such column" like the 0009/0010 pieces. A claimed row never shows the flag.
- README line added in `functions/_dev/README.md`.
- Commit: see `git log` on the branch (head reported in the reply).

## 2. Tests

- Clean main (before any change): `node --experimental-default-type=module --test functions/_dev/tests/*.test.js` -> 167 tests, 167 pass, 0 fail.
- Branch: 177 tests, 177 pass, 0 fail (10 new in `functions/_dev/tests/ready.test.js`: form words/placement/optional, handler with the column, handler before the migration, a non-column DB error still fails visibly, migration shape and constraints, admin flag, sort in every tab, admin before the migration, trim with and without the column, trim wiring).
- One existing test (`admintabs.test.js` O7) counted D1 batches and broke because the new first-tried form fails once on a database without 0013 (rolled back, harmless). Fix: the admin tests' stand-in database now applies 0013 like production will; "before 0013" is covered in `ready.test.js`.
- Checked that the new tests can fail: removing the sort failed R7; removing the trim piece failed R9.
- No real requester data anywhere; all values are made up.

## 3. Changed on which machine

None. Nothing published, no D1 migration run (prod or preview), nothing merged to main. Branch pushed to origin only.

## 4. Needs Allen

- **Migration to paste** into the D1 console (production and preview), any time before or after the publish (the code works either way). Not safe to run twice (a second run fails with "duplicate column name", nothing changes):
  `ALTER TABLE invite_requests ADD COLUMN ready_soon INTEGER DEFAULT 0 CHECK (ready_soon IS NULL OR ready_soon IN (0, 1));`
  Until it is run, a ticked box is not recorded (the request itself is still saved), so run it before publishing.
- **Publish go** for the branch (merge to main, Cloudflare Pages deploy).
- **GTM's privacy line at publish** (do not publish the form without it): §3 "Invite requests", after "the plan you're interested in,": "whether you said you're ready to set up and start using Bervo within a few days," plus the history line "Version 1.N — <date>: the invite request record also keeps whether you said you're ready to set up and start using Bervo within a few days." (next free version number at publish; the newsletter draft is 1.17).

## Findings

- 0013 is "next free" only by the migrations on main and the newsletter branch (0012); a branch I did not look at could also claim 0013.
- Edge case, not fixed: a database with 0013 but without 0010 would skip the ready erase (0013 follows 0010, so this should not occur).
