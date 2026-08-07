# EvolvTrack

EvolvTrack records a person's GLP-1 treatment, inventory, and observed outcomes. Its language distinguishes facts the person records from estimates derived from those facts.

## Treatment log

**Health Entry**:
A dated treatment observation. It may contain a weigh-in, wellness score, symptoms, notes, or a dose; multiple entries may share a date.
_Avoid_: Row, record, event

**Weigh-in**:
A body-weight observation within a Health Entry.
_Avoid_: Weight entry

**Wellness Score**:
A person's subjective wellness rating from 0 through 10 within a Health Entry.
_Avoid_: Health score

**Dose**:
An amount of one Medication assigned to a date. A Dose is planned, taken, or skipped.
_Avoid_: Shot, injection entry

**Planned Dose**:
A Dose expected but not yet treated as administered or skipped. It contributes only to projections and does not consume Vial inventory.
_Avoid_: Pending dose

**Taken Dose**:
A Dose treated as administered rather than planned or skipped. It consumes Vial inventory and contributes to observed treatment estimates.
_Avoid_: Confirmed dose, actual dose

**Skipped Dose**:
A planned Dose the person records as not administered. It remains part of treatment history but does not consume inventory or contribute to treatment estimates.
_Avoid_: Deleted dose, missed entry

**Medication**:
The drug associated with a Dose or Vial, including its recognized brand grouping.
_Avoid_: Type, drug type

## Medication inventory

**Vial**:
A physical medication container with its own fill, concentration, sourcing, dates, cost, and usage history.
_Avoid_: Prescription, medication row

**Vial Attribution**:
The single Vial from which a Taken Dose was drawn. A Dose is never divided between Vials.
_Avoid_: Prescription link, vial mapping

**Vial Capacity**:
The labeled medication amount in a Vial, calculated from its concentration and volume.
_Avoid_: Available amount

**Vial Level**:
The estimated medication remaining in a Vial after attributed Taken Doses and any Vial Usage Adjustment.
_Avoid_: Doses left

**Vial Usage Adjustment**:
A manual correction to a Vial's consumed amount for usage outside the treatment log or a known attribution discrepancy.
_Avoid_: Override, manual mg used

**Archived Vial**:
A Vial retained in treatment and spending history but hidden from the default inventory view.
_Avoid_: Deleted vial, inactive prescription

## Derived treatment insights

**Treatment Week**:
A rolling seven-day treatment period, beginning with the earliest Health Entry rather than a calendar-week boundary.
_Avoid_: Calendar week

**Amount in System**:
A pharmacokinetic estimate of a Medication in the modeled body compartment at a point in time; it is not a clinical measurement.
_Avoid_: Blood level, measured drug level

## Sync privacy

**Encryption Transition**:
A change to how a person's synchronized data is protected: enabling E2EE, disabling E2EE, or rotating the active encryption key. Only one Encryption Transition may be active for a person's synchronized data at a time.
_Avoid_: Recovery transition, encryption migration

**Recovery**:
Regaining access to E2EE data with a recovery code. Recovery authorizes a new Encryption Transition that rotates the active encryption key.
_Avoid_: Recovery transition, recovery migration

**Recovery Code Acknowledgment**:
A person's confirmation that they saved a newly issued recovery code. It confirms a recovery option; it does not determine whether an Encryption Transition succeeded.
_Avoid_: Window closure, interruption

**Recovery Code Opt-Out**:
A person's account-wide choice to use the current active encryption key without a recovery code. It invalidates any unconfirmed recovery code and suppresses reminders until a new encryption key becomes active or the person chooses to generate one.
_Avoid_: Recovery failure, missing acknowledgment

**Recoverable Copy**:
Synchronized treatment data that remains available as readable local Health Entries and Vials, unlockable ciphertext, or a restorable backup.
_Avoid_: Usable local data, surviving rows

**Device Data Erasure**:
The non-cancellable process that removes the account session, encryption keys, health data, and preferences stored by one copy of EvolvTrack without changing synced cloud data, other devices, or exported backup files. It completes only after removal is verified; interrupted erasure resumes before normal app use. Signed-in Device Data Erasure happens through "Log out"; when already signed out, the user-facing action is "Remove app data."
_Avoid_: Local cleanup, clear local data, wipe

**Start Fresh**:
The destructive recovery action that abandons synchronized treatment data after the person confirms no Recoverable Copy exists. It returns sync to plain mode only after cloud changes and wrapped keys are verified deleted.
_Avoid_: Hard reset, start over
