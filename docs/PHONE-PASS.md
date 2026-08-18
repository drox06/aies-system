# Phone pass

A checklist for reviewing the platform on a phone, on the live Vercel site.

This is a **review**, not a test run. You are looking for things that are wrong or awkward on a small
screen, writing them down, and handing the list back. Nothing here changes data that matters — but
where a step does write something, it says so and tells you how to undo it.

Do it on your own phone, on mobile data rather than office wifi, because half of what this is
checking is how the app behaves on a slow or missing connection.

---

## Before you start

**Where:** https://aies-system.vercel.app

**Sign in as EA.** Your own account, your own TOTP. No other account is needed for any step here.

**Have a notes app open.** For each problem, the useful note is three things: which screen, what you
expected, what happened. A screenshot beats a description — the volume button takes one without
leaving the page.

**One habit worth keeping:** when something looks wrong, check whether it is wrong *or just tight*.
A button that is hard to hit and a button that does the wrong thing are different reports, and the
second is much more urgent.

---

## 1. Install it as an app (2 minutes)

The platform is a PWA, and it is meant to live on the home screen rather than in a browser tab. This
step is first because everything after it should be done **inside the installed app**, not in Safari
or Chrome — the two look similar and behave differently around storage and offline.

**iPhone:** Safari → Share → *Add to Home Screen*.
**Android:** Chrome → ⋮ → *Install app* or *Add to Home screen*.

Then open it from the home screen icon.

- [ ] The icon looks right on the home screen — not a blank page or a stretched screenshot
- [ ] Opening it fills the screen with no browser address bar
- [ ] The AIES mark appears while it loads rather than a white flash

> If *Add to Home Screen* does not appear on iPhone, you are probably in Chrome. On iOS only Safari
> can install a PWA. Worth noting either way.

---

## 2. The delivery screen — `/field` (10 minutes, the important one)

Go to **https://aies-system.vercel.app/field**

This is the screen built for a driver holding a box in sunlight, and it is the one screen in the
platform that **has never been looked at on a real device**. Everything else in this document has at
least been seen on a desktop. Spend your time here.

It deliberately has no sidebar, no search and no notification bell. That is the design, not a
loading failure.

**Reachability — the one-handed test.** Hold the phone in one hand, the way you would while carrying
something, and try to use it with your thumb only.

- [ ] Can you reach every button you need without shifting your grip?
- [ ] Are the big action buttons ("Delivered and signed", the failure reasons) comfortable to hit, or
      do you have to aim?
- [ ] Does anything important sit under the top notch or the bottom home bar?

**Outdoors.** Take the phone outside, or to a window in full daylight, and look at the same screen.

- [ ] Can you read it without shading the screen with your hand?
- [ ] Is the difference between a pressed and unpressed button obvious outdoors?

**Content.**

- [ ] Does the top bar say either "Everything sent" or "*n* waiting to send"? It should always say one
      of them — it is meant to answer "is my work safe?" at a glance
- [ ] Tap a delivery. Does it expand to show the address, access notes and what is being delivered?
- [ ] Does **Navigate** open your maps app with the right destination?
- [ ] Is the address readable and correct, or is it a mangled run-on?

> **Careful here:** the seven "could not deliver" buttons and "Delivered and signed" **record a real
> delivery attempt** against a real ticket. Do not tap them on anything that matters. If you want to
> try one, tell me first and I will make you a throwaway delivery to practise on. Reading the screen
> and tapping *Navigate* changes nothing.

**Empty state.** If no deliveries are out, you will see "No deliveries are waiting to go out." That is
correct behaviour, not a bug — but tell me if it looks like a broken page rather than an answer.

---

## 3. Offline behaviour (5 minutes)

The point of §14 is that a plant has no signal. Worth seeing what actually happens.

**Turn on airplane mode**, then:

- [ ] Open the app from the home screen. What do you get — the offline notice, a blank page, or a
      spinner that never resolves?
- [ ] If you already had `/field` open before going offline, does the list stay on screen, or does it
      empty out?

**Be warned about what is not built yet.** Offline *reads* are not finished. If you open the app cold
with no signal you will get an offline notice rather than your deliveries. That is the current honest
state, not a fault to report — the thing to tell me is whether the notice is *clear* about what is
happening.

**Turn airplane mode off** and confirm the app recovers without needing a force-quit.

---

## 4. The everyday screens (15 minutes)

Sign in and walk these in order. For each, the questions are the same: **does it fit, can you read
it, can you tap it, does anything overflow sideways?**

Horizontal scrolling is the main thing to hunt for. Tables and wide cards are the usual culprits.

- [ ] **My day** — the landing screen after sign-in. Is it useful on a phone or just a wall?
- [ ] **Pipeline** — the kanban board. Columns on a narrow screen are the hardest layout in the
      platform; expect this to be the worst one and tell me how bad
- [ ] **Inquiries** — list, then open one
- [ ] **Quotations** — list, then open one. Check the **Lines** section especially: it has the most
      columns anywhere in the app
- [ ] **Accounts** — list, then open a customer
- [ ] **Tickets** — list, then open one. Scroll the whole record; it has the most panels
- [ ] **Sales orders**, **Procurement**, **Suppliers**, **Store**, **Warranty**, **Projects**,
      **Site inspections**, **Cash advances** — a quick look at each

**On every one:**

- [ ] Does the page scroll sideways when it should not?
- [ ] Is any text too small to read without zooming?
- [ ] Do buttons sit close enough together to mis-tap?
- [ ] Does the navigation menu open, work, and close?

---

## 5. Files and photos (5 minutes)

You checked upload and download on desktop. The phone path is different — the camera is involved.

Open a site inspection or a ticket with attachments.

- [ ] Does tapping upload offer **Camera** as well as **Photo Library**?
- [ ] Take a photo and attach it. Does it upload, and does the thumbnail appear?
- [ ] Tap it to view. Is it readable full-screen?
- [ ] Download it. Where does it land, and can you find it afterwards?

> This uploads a real file to a real record. Delete it afterwards with the remove control, or tell
> me which one to clean up.

---

## 6. Sign out and back in (2 minutes)

- [ ] Sign out. Does it return you to the login screen cleanly?
- [ ] Sign back in. Is the TOTP field easy to use on a phone — does the keyboard show numbers?
- [ ] Are you landed on **My day** rather than anywhere else?

---

## What to send back

A list. For each item: **screen, what you expected, what happened**, and a screenshot where it
helps.

Sort it your way, but it helps me to know which of these each one is:

- **Wrong** — it does the wrong thing, shows the wrong number, or does not work
- **Unusable** — it works but you would not want to do it twice on a phone
- **Ugly** — it works fine and looks bad

I will fix Wrong immediately, plan Unusable, and batch Ugly into one pass.

---

## Known already — no need to report

These are on the list, so seeing them is expected:

- Offline reads are not built; the app needs a connection to load a screen for the first time
- `/field` has no photo *preview* after capture — it says "*n* photos will be saved" and that is all
- There is no signature capture on `/field` yet; §14 asks for one and it is not built
- The Home page (`/`) exists but is not in the navigation, by decision
- Some lists may be empty — the test data was purged, and only real work is in there now
