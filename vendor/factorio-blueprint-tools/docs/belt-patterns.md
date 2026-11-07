# Factorio 2.0 belt mechanics and layout patterns

Reference for the blueprint-analysis tool. Every mechanic below was read from the
cited source; anything not confirmed by a source is marked **unverified**. Reddit could
not be fetched (blocked to the crawler), so sources are the official wiki, the official
forums, Friday Facts, Steam discussions and mod pages.

Diagram legend: `^ > v <` belt (direction of travel); `u` underground entrance, `U`
underground exit; `S` splitter tile (2x1, two `S` side by side); `i` inserter; `F`
furnace tile; `A` assembler tile; `.` empty ground. "Left/right lane" is always from
the belt's own point of view (for a `^` belt, left = west, right = east).

Belt tiers and throughput (wiki): basic 15/s, fast 30/s, express 45/s, turbo 60/s
(turbo is Space Age only). Sources: https://wiki.factorio.com/Belt_transport_system
https://wiki.factorio.com/Turbo_underground_belt

---

## 1. Lane mechanics

**Inserters drop onto the far lane.** Wiki: inserters "place the item on the furthest
lane. If a belt is in the same orientation as the inserter, the item will be placed on the
right-hand lane, from the belt's perspective." On curves they also use the far side.

```
  i ^        inserter west of a north belt, dropping east -> items land on the EAST (right, far) lane
  ^ i        inserter east of the belt                    -> items land on the WEST (left, far) lane
```
Two inserters on opposite sides therefore fill both lanes; two on the same side fill one
lane only.

**Sideloading: all items of the feeding belt go onto the near lane of the target.** A
belt that runs head-on into the *side* of another belt is a sideload (not a curve). Both
lanes of the feeder are squeezed onto the single lane of the target on the side the feeder
arrives from. Steam: "If you have a fully loaded north-traveling belt make a left turn
into another north-traveling belt, then you will end up with product only on the right
side of the belt." Forum (JasonC): "When side-loading to a saturated belt the 'upstream'
lane has precedence."

```
      ^
      ^
  > > ^      feeder from the west joins the side of the north belt:
      ^      every feeder item ends up on the WEST (left, near) lane of the ^ belt
      ^
```
Contrast with a curve (the target belt *starts* at the junction tile, nothing feeds it from
behind): a curve keeps both lanes.

**Underground lane filter.** Wiki: "The half of the underground belt tile with a belt can
accept input from the side. The other half (with a tunnel entrance) blocks incoming items."
Forum (Loewchen): "Because there is no path onto the underground belt, only the outer side
of the corner can enter." So when a belt sideloads into an underground tile, only the
feeder lane that lines up with the open belt half passes; the lane lining up with the hood
is blocked and backs up. Which half is the hood depends on entrance vs exit (derived from
the wiki sentence):

```
  north-facing ENTRANCE  u : hood on the NORTH half, open belt on the SOUTH half
  north-facing EXIT      U : hood on the SOUTH half, open belt on the NORTH half

        (to U)                      ^  (continues north)
  > > > u     feeder's SOUTH lane    > > > U     feeder's NORTH lane passes,
              (its right lane)                   its SOUTH lane is blocked
              passes, NORTH lane
              is blocked
```
The wiki's "Separating belt lanes" section describes exactly this: place an underground
belt and press R to reverse it, "which converts the underground belt entrance to an exit
(and vice versa)", picking the other lane. Wiki also states "it is also possible to unmerge
a mixed belt by using underground belts since an underground belt will block half of the
belt." Items that pass the filter land on the underground's near lane (sideload rule).

**Classic trick - strip one lane off a belt (lane filter):** run the belt head-on into the
side of an underground entrance or exit as above. Only one lane continues through the
tunnel; the other lane stops at the junction. This is a filter, not a split: the blocked
lane has nowhere to go unless routed upstream (see section 3).

Sources: https://wiki.factorio.com/Inserters https://wiki.factorio.com/Belt_transport_system
https://forums.factorio.com/viewtopic.php?t=60991 https://forums.factorio.com/viewtopic.php?t=23643
https://steamcommunity.com/app/427520/discussions/0/412448792370725794/

---

## 2. Splitter mechanics (2.0)

Wiki, verbatim where quoted:
- "Splitters are a 2x1 entity that splits incoming items on belts from up to two input to
  up to two outputs, in a 1:1 ratio."
- "If one of the outputs is fully backed-up and the splitter cannot split evenly, it will
  put all input on its other output."
- "Splitters can also merge belts, taking two inputs and one output."
- "Splitters preserve the lanes of the items, by moving through the splitter an item on
  the right lane will not be moved to the left lane, and vice versa." Lane splitting is
  independent per lane and independent of item type (since 0.16.16).
- **Input priority**: the splitter will "first try to consume the specified input side,
  and will only consume the other input once there is a gap on the prioritized input belt."
- **Output priority**: "try to redirect all incoming items to the specified output, and
  will only output on the other output once the specified output is full."
- **Filter**: "One output of the splitter can be filtered to one item." "All items of the
  set type will be redirected to that specific output and all other items are directed to
  the other output." One item type per splitter (quality can be part of the filter; a
  quality wildcard is static-only, not circuit-settable - forum t=131949).
- 2.0 change: "Splitters can be connected to the circuit network" (2.0.67). Priority and
  filter themselves date from 0.16.17 and are unchanged in behaviour.

**Pulling one item off a mixed belt** (filter set to X on the north output):
```
      ^  (X only; non-X never goes here)       ^  (everything except X)
      S  S     <- splitter, facing north, filter X on the left output
      ^  .
      ^        mixed belt in
```
Lanes are preserved: X that rode the right lane of the input is still on the right lane
of the filtered output. If the filtered output is blocked, X items wait in the splitter
rather than leaking to the other side (wiki: items of the filtered type "will only go to
that output, and not to the other one").

Sources: https://wiki.factorio.com/Belt_transport_system https://wiki.factorio.com/Splitter
https://forums.factorio.com/viewtopic.php?t=131949

---

## 3. T-junctions, merging and splitting

**Fill both lanes from two sources (the standard two-item belt):** sideload from opposite
sides, or use inserters from opposite sides (section 1).
```
      ^
  > > ^ < <      west feeder -> west lane,  east feeder -> east lane
      ^
```
A belt running *across* a splitter output behaves the same way: wiki "Belts going across a
splitter will have items from the splitter moving to one side of the crossing belt."

**Merge two half belts into one full belt:**
- Two belts that each carry items on one lane only, on *opposite* lanes, merge losslessly
  through a splitter used as 2-in/1-out, because lanes are preserved.
- Two belts carrying items on the *same* lane: sideload each from a different side of the
  target (diagram above); each feeder's single lane lands on the near lane of the target.
- Sideloading a full two-lane belt onto a target only yields one lane of output (forum
  t=42554: "only one lane from each side feeder is moving onto the single production
  line"). Throughput is halved - a linter can flag a saturated belt ending in a sideload.

**Split a belt into two half belts:**
- A splitter with nothing else gives two belts with *both* lanes at half density (not one
  lane each).
- Lane separator (each lane to its own belt). Forum t=102968: "You can use the
  side-load-onto-underground-trick to achieve a perfect split of 1 belt onto 2 half-belts."
  The layout below is derived from the verified rules (per-lane splitter independence +
  "put all input on its other output" when one side backs up + the underground lane
  filter); the exact tile layout from that thread was a GIF, so treat the picture as
  **unverified** and test in-game:
```
  y=0:  > > > S > u . .     u = north-facing ENTRANCE: passes feeder's SOUTH (right) lane,
  y=1:        S > > U       its NORTH lane backs up -> splitter routes north-lane items to y=1
                            U = north-facing EXIT (paired with an unfed entrance to its south):
                            passes feeder's NORTH (left) lane, its SOUTH lane backs up.
                            Result: column x=5 carries only right-lane items, x=6 only left-lane.
```
- Mixed belt with a different item per lane: a filter splitter (section 2) separates the
  items and keeps each on its original lane.

**Lane balancer (splitter + sideload):** forum t=23643 - one splitter output sideloaded
back onto the other output puts all items on one lane so a following splitter draws from
both input lanes evenly.

Sources: https://wiki.factorio.com/Belt_transport_system https://forums.factorio.com/viewtopic.php?t=42554
https://forums.factorio.com/viewtopic.php?t=102968 https://forums.factorio.com/viewtopic.php?t=23643

---

## 4. Two-item (half-sushi) mall belts and why a third item jams

Wiki: "Belts of all tiers have 2 lanes ... This allows for either a double flow of one
material, or to transport two different materials on the same belt." Wiki defines a sushi
belt as "a transport belt that holds more than one type of item per lane", and warns that
"looping a belt may result in clogging".

Mall designs keep exactly one item type per lane: iron plates sideloaded or inserted from
one side, gears (or a second ingredient) from the other. Forum t=64918's full-belt mall
uses "gears, two iron belts for the yellows, and a half green, half red circuit belt".
```
  plates > > ^ < < gears        ^ lane W = plates, lane E = gears
             ^ i A A A
             ^ i A A A          assemblers pick whichever lane holds what they need
```
Why it is reliable: each lane is a single-item queue. An inserter never takes an item its
target cannot accept (wiki: inserters will not "Pick up any items that cannot be inserted
into the adjacent entity"), so an unwanted item sitting in front of an assembler is simply
skipped - it is never blocking the *other* item, because that item is on the other lane.

Why a third item jams: it must share a lane with one of the others, so the lane becomes a
mixed queue. When the front item on that lane is not consumed, everything behind it stops.
Forum t=49844 (Xtrafresh): "the belt always needs to be moving. If you ever back it up, or
have an uneven draw from it so one of the two items back it up, half your factory will shut
down." Three-plus items per belt need a loop plus filter-splitter removal or circuit-gated
insertion (wiki Sushi belts; forum t=56564). A linter rule: more than one item type feeding
a single lane, without a loop or circuit control, is a deadlock risk.

Sources: https://wiki.factorio.com/Belt_transport_system https://wiki.factorio.com/Sushi_belts
https://forums.factorio.com/viewtopic.php?t=49844 https://forums.factorio.com/viewtopic.php?t=56564
https://forums.factorio.com/viewtopic.php?t=64918 https://wiki.factorio.com/Inserters

---

## 5. Underground reach and crossing rules

| Tier    | Wiki "underground distance" (tiles between entrance and exit) | Prototype `max_distance` |
|---------|------|---|
| basic   | 4    | 5 |
| fast    | 6    | 7 |
| express | 8    | 9 |
| turbo (Space Age) | 10 | 11 (**unverified** - inferred from the +2 pattern; wiki gives 10) |

Wiki: "The underground distance is 4, 6 and 8 tiles, respectivly, for the three belt types
in base game"; turbo "10 tiles - 2 more than a express underground belt". Forum t=89116
(Rseding91): max_distance "is set as 5 in the prototype but ... that's from the edge of the
first underground belt to the tile the exit is on." Practical blueprint rule: with an
entrance at tile x, the exit may be at most at x + max_distance, i.e. up to 4/6/8/10 empty
tiles between them.

```
  basic, maximal:   u . . . . U      (4 gap tiles, exit 5 tiles from entrance)
```

**Crossing / braiding.** Wiki: "Different types of underground belts can be braided together
along the same line of tiles, with items staying in their respective belt types." Same-tier
undergrounds on the same axis cannot cross: an entrance pairs with the nearest compatible
same-type exit in range, so a second same-type pair in the gap would steal the connection.
Evidence: the wiki only allows braiding for *different* types, and both the Same Tier
Braiding mod ("Adds new transport belts with the same speed as existing ones to enable
braiding of belts with the same speed") and Braidy Belts ("you can now braid with same speed
underground belts. Simply alternate between pairs of vanilla/modded underground belts and
braidy belts") exist solely to work around that vanilla restriction. The exact pairing
algorithm (nearest vs. first) is **unverified**.
```
  u(yellow) u(red) . . U(red) U(yellow)     OK: different tiers braid
  u(yellow) u(yellow) . U(yellow) U(yellow) NOT a crossing: the inner pair connects first
```
Undergrounds of *perpendicular* axes never interact. Undergrounds cannot pass under lava or
space void (wiki). Linter rules: tier-matched entrance/exit, same axis, opposite
in/out types, distance <= max_distance, and no same-tier underground of the same axis
between them.

Sources: https://wiki.factorio.com/Belt_transport_system https://wiki.factorio.com/Fast_underground_belt
https://wiki.factorio.com/Express_underground_belt https://wiki.factorio.com/Turbo_underground_belt
https://forums.factorio.com/viewtopic.php?t=89116 https://mods.factorio.com/mod/SameTierBraiding
https://mods.factorio.com/mod/BraidyBelts https://forums.factorio.com/viewtopic.php?t=51809

---

## 6. Inserter pickup and drop rules

From https://wiki.factorio.com/Inserters unless noted:
- **Drop lane**: always the far lane; parallel to the belt = the belt's right lane.
- **Pickup lane**: perpendicular belt - "inserters prefer taking items from the nearest
  lane. If the nearest lane is empty, the inserter will take from the far lane." Parallel
  or curved belt - prefer the belt's left lane, then the right.
- **Target filtering**: inserters will not "Pick up any items that cannot be inserted into
  the adjacent entity", and will not "Fill up the entire target inventory" of boilers,
  reactors, production buildings, furnaces and turrets. This is what lets a mixed belt feed
  a row of assemblers with different recipes without explicit filters.
- **Long-handed inserter**: picks up and drops "two tiles from its location instead of the
  usual one"; "commonly used for placing items on a belt that is three tiles away" from an
  assembler or furnace (i.e. it skips the adjacent tile). It "may have trouble grabbing
  moving items from red/blue turning belts if the item is on the far side."
  https://wiki.factorio.com/Long-handed_inserter
- **Underground tiles**: inserters can pick from the entry/exit tile but "the time they
  have to pick up is shorter", so throughput is lower. Dropping onto underground tiles:
  works like a belt tile, but only the open half is belt (**unverified** for drop timing).
- **Splitter tiles**: dropping onto a perpendicular splitter is *better* than a belt: "a
  fully-upgraded bulk inserter can fill 71% of an express belt lane instead of the usual
  64%." Picking up from a splitter tile: **unverified**.
- **2.0 changes**: filter inserters are gone - "all inserters now have filter option"
  (wiki history, 2.0); the old stack inserter is renamed bulk inserter; the Space Age
  *stack inserter* can stack up to 4 items per belt slot. FFF-393: "Inserters can only put
  items into empty spots on belts, no putting onto existing stacks. Side-loading and
  splitters do not modify the stack heights at all." https://factorio.com/blog/post/fff-393
- **2.1, not 2.0**: FFF-442 (June 2026) adds "using the flip hotkey it is possible to
  adjust which side of the belt a machine will drop to" and "inserters will now always drop
  to the input sides of splitters." A 2.1 blueprint may therefore carry a near-lane drop;
  for 2.0.x blueprints the far-lane rule is absolute (forum t=134251: "it's now a vanilla
  feature in 2.1, check FFF #442"). https://factorio.com/blog/post/fff-442
  https://forums.factorio.com/viewtopic.php?t=134251

---

## 7. Furnace and mall columns - lane usage

**Furnace column.** Standard belt design: "a symmetrical line of two rows of furnaces, with
items being fed from the top and bottom of either row" (TheGamer); either one input belt
with ore on one lane and coal on the other so "one Inserter can take both the coal and ore
needed for a single furnace" (TheGamer), or separate ore and coal belts with long-handed
inserters reaching the far one (Steam smelting guide summary). Output: both rows drop onto
a shared plate belt between them, and because each inserter drops on its far lane, the west
furnaces fill the east lane and the east furnaces fill the west lane - the forum advice
"bring the output of the right iron plates to the left lane of the belt" (t=2046) happens
automatically. Ratios: 48 stone or 24 steel/electric furnaces per 15/s belt, 96/48 per
30/s, 144/72 per 45/s (factoriocalculator.blog).
```
  ore+coal   plates   ore+coal        each row of the column (belts run north):
  ^ i F F i   ^   i F F i ^           W furnaces -> plate belt EAST lane
  ^   F F     ^     F F   ^           E furnaces -> plate belt WEST lane
```
A column with furnaces on one side only fills one lane and caps at half a belt.

**Mall column.** Assemblers line a bus of one or two ingredient belts; the near belt is
reached by normal inserters, the second by long-handed (2-tile reach). Two ingredients per
belt, one per lane (section 4). Output inserters on one side put every product on the same
(far) lane of a shared output belt, which is fine because products are picked by filtered
inserters/chests, not consumed in order.
```
  belt2  belt1                    belt1: plates W lane / gears E lane
  ^      ^  i  A A A  i  >  out   belt2: green W / red E (half-and-half circuit belt,
  ^      ^ (long) A A A             as in the forum mall)
```
Sources: https://www.thegamer.com/factorio-smelting-furance-array-setup-guide/
https://forums.factorio.com/viewtopic.php?t=2046 https://factoriocalculator.blog/factorio-smelting-setup/
https://forums.factorio.com/viewtopic.php?t=64918 https://wiki.factorio.com/Long-handed_inserter

---

## Summary of 1.1 -> 2.0 (and 2.1) changes relevant here

- Unchanged from 1.1: far-lane drop, sideload-onto-near-lane, underground lane filter,
  splitter lane preservation, splitter priority and single-item filter, 4/6/8 reach.
- New in 2.0: turbo tier (60/s, reach 10, Space Age); all inserters have filters; belt
  stacking via stack inserters (sideload/splitters keep stack height); splitters on the
  circuit network (2.0.67); quality in splitter filters.
- New in 2.1 (FFF-442): flip hotkey chooses the drop side of a belt; inserters drop onto a
  splitter's input side.
