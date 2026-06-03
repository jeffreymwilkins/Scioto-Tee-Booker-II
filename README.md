# Scioto Country Club — Tee Time Booker

A personal robot that books your tee time at Scioto Country Club the **instant**
the booking window opens — 7 days in advance, at 7:00:00 AM ET. A human clicking
refresh can't reliably win the popular slots. This robot can.

You tell it when you'd like to play, who you're playing with, and it does the
rest while you sleep.

---

## Received this as a gift? Start here.

This guide walks you through setting up **your own private copy** of the booker,
connected to **your own** Scioto login. No coding required — just careful,
step-by-step clicking.

- **Time needed:** about 45 minutes of focused work, plus a little back-and-forth
  with the person who gave you this gift (we'll call them your **gift-giver**).
- **Difficulty:** if you can fill out a form online, you can do this.
- **You'll coordinate with your gift-giver** in Part 1, and you'll want them
  available for one quick step in Part 4. Both are explained where they happen.

Read each part **in order** and don't skip ahead. Take your time.

---

## For the person sharing this gift (read this first)

This project is set up so each recipient gets their **own private, independent
copy** of the robot. Once they have it, nothing they do can affect yours — and
nothing you do affects theirs.

**One-time setup:** mark your repository as a template. On GitHub, open your repo
→ **Settings → General** → scroll to **"Template repository"** and tick the box.

**For each recipient,** you'll do the short, friendly back-and-forth in Part 1:

1. They send you their GitHub username → you invite their account to your repo
   (repo → **Settings → Collaborators → Add people**).
2. They click **"Use this template"** to create their **own** copy.
3. They confirm they're done → you remove their access (same **Collaborators**
   page → **Remove**). Their copy keeps working — it's completely independent.

Also be available for **Part 4, Step 3** — the one-command "container stack"
step. It takes about 30 seconds; the instructions are right there in that step.

---

## What the robot does, in plain English

Scioto's tee sheet opens **exactly 7 days in advance at 7:00:00 AM ET**, and the
best slots are gone within seconds.

1. You schedule a desired play date through a simple web dashboard — e.g.
   *"Saturday the 14th, sometime between 9:00 and 11:00 AM, with these two
   partners."*
2. At **6:58 AM ET**, 7 days before that date, the robot wakes up and logs in
   to ForeTees.
3. At **7:00:00 AM ET** sharp, the instant the tee sheet opens, it grabs the
   best available slot inside your time window and books it.
4. It fills in your partners and guests, submits, and double-checks that your
   name landed on the slot.

The robot also knows Scioto's **play-window rules** (when each member category
and their guests are allowed on the course). If you ask for a time the rules
don't allow — e.g. a guest at 8 AM on a Saturday — it **silently shifts your
window to the nearest allowed time** instead of failing the booking. The
dashboard shows you the adjustment.

You can add up to **3 other players** (any mix of Scioto member partners and
non-member guests), plus yourself.

---

## What you'll need before you start

Gather these now so you're not hunting for them mid-setup:

- A computer with a web browser (this is much easier on a computer than a phone).
- **Your Scioto Country Club login** — the username and password you use for the
  Scioto member website / ForeTees tee time system.
- **Your name exactly as ForeTees shows it.** Log in to ForeTees once and look
  at how your name appears on the tee sheet or the player panel — including any
  middle initial (for example, `John A Smith`). You'll need it character-for-character.
- An email address.
- **A credit card.** The hosting service (Heroku) requires one. The ongoing cost
  is about **$5 per month** — see "What it costs" at the bottom.
- About 45 uninterrupted minutes, and your gift-giver reachable for Part 1.

---

## The big picture: three accounts

You'll sign in to three services. Here's what each one is for, so nothing feels
mysterious:

| Service    | What it's for                                              | Cost        |
|------------|------------------------------------------------------------|-------------|
| **GitHub** | Holds your copy of the robot's code and remembers your bookings | Free   |
| **Heroku** | Runs the robot 24/7 so it's awake at 7 AM                   | ~$5/month   |
| **Scioto / ForeTees** | Your golf club account — you already have this  | Already yours |

The setup is just: create the accounts, copy a few values between them, and
press "Deploy." Let's go.

---

## Part 1 — Get your own private copy of the robot (~10 minutes)

The robot's code is shared as a GitHub **template**. In this part you'll do a
short, friendly back-and-forth with your gift-giver to get **your own** copy.
Do the steps in order — some are yours, some are your gift-giver's.

1. **You — create a GitHub account.** Go to **github.com**, click **Sign up**,
   and create an account (skip this if you already have one). Verify your email.
   Note your **username**.

2. **You — reach out.** Send your gift-giver your GitHub **username** and let
   them know you're ready to start.

3. **Gift-giver — send a temporary invitation.** They invite your GitHub account
   to view their project. (They'll remove this access again at the end — it's
   only needed for the next two steps.)

4. **You — accept the invitation.** Check your email for a GitHub invitation, or
   go to **github.com/notifications**. Click **Accept invitation**.

5. **You — create your own copy.** Open the project page (the link is in the
   invitation email). Near the top, click the green **"Use this template"**
   button, then **"Create a new repository."** Fill in:
   - **Owner:** your own account.
   - **Repository name:** something simple, e.g. `my-tee-booker`.
   - **Visibility:** choose **Private**.
   - Click **Create repository**.

   GitHub now creates **your own independent copy** of the robot's code. This
   copy belongs entirely to you.

6. **You — confirm.** Message your gift-giver: *"Done — I've created my copy."*

7. **Gift-giver — close the door.** They remove your temporary access to their
   project. Your copy is completely separate and unaffected — nothing connects
   the two repositories anymore.

> **You now have your own repository.** Everything from here on happens in *your*
> copy and *your* accounts. Keep the web address of your new repository handy
> (it looks like `https://github.com/your-username/my-tee-booker`) — you'll need
> it in Part 4.

> *Good to know:* your copy is a complete snapshot and will keep working on its
> own. If your gift-giver improves the robot later and you'd like the update,
> just ask them — it's a quick repeat of this part.

---

## Part 2 — Set up booking storage (~10 minutes)

The hosting service erases its short-term memory roughly once a day when it
restarts. So your queued bookings need to be saved somewhere lasting. We use a
free GitHub feature called a **Gist** for this.

### 2a. Create the storage Gist

1. While signed in to GitHub, go to **gist.github.com**.
2. In the box labeled **"Filename including extension…"**, type exactly:
   ```
   bookings.json
   ```
3. In the large text area below it, type exactly these two characters:
   ```
   []
   ```
4. Click the small **arrow** next to the green "Create … gist" button and choose
   **Create secret gist**. ("Secret" just means it isn't listed publicly.)
5. Look at the web address of the page you land on. It looks like:
   ```
   https://gist.github.com/yourname/3f9a2b8c1d4e5f6a7b8c9d0e1f2a3b4c
   ```
   That long code at the end is your **Gist ID**. Copy it into a note on your
   computer — label it `GIST_ID`.

### 2b. Create an access token

The robot needs permission to read and write that Gist. That's what a "token"
is — like a special password just for this one job.

1. Go to **github.com**, click your **profile picture** (top-right) → **Settings**.
2. In the left menu, scroll all the way down to **Developer settings**.
3. Click **Personal access tokens → Tokens (classic)**.
4. Click **Generate new token → Generate new token (classic)**. Confirm your
   password if asked.
5. Fill in:
   - **Note:** `tee time booker`
   - **Expiration:** choose **No expiration** (so your robot never stops working).
   - **Scopes:** check the **single** box labeled **`gist`**. Leave every other
     box unchecked.
6. Click **Generate token**.
7. **Copy the token immediately** — GitHub will never show it again. It looks
   like `ghp_aBcD1234…`. Paste it into your note, labeled `GIST_TOKEN`.

You should now have two values saved: `GIST_ID` and `GIST_TOKEN`. Keep them safe.

---

## Part 3 — Create your Heroku account (~5 minutes)

Heroku is the service that runs your robot around the clock.

1. Go to **heroku.com** and click **Sign up**. Fill in the form (any answers for
   role/company are fine). Verify your email and set a password.
2. Heroku requires **two-factor authentication**. When prompted, follow its
   steps to set this up (usually with a phone authenticator app). This is a
   normal security measure — just follow the on-screen instructions.
3. Add a payment method: click your **avatar (top-right) → Account settings →
   Billing → Add credit card**. Heroku verifies the card but does not charge you
   until you turn on a paid resource (Part 4).

---

## Part 4 — Create and configure your robot (~15 minutes)

This is the main event. Follow each step closely.

### Step 1 — Create the app

1. Go to **dashboard.heroku.com**. Click **New → Create new app** (top-right).
2. **App name:** pick something unique and lowercase with dashes, e.g.
   `smith-tee-booker`. (If the name is taken, add a number.)
3. **Region:** United States.
4. Click **Create app**.

### Step 2 — Subscribe to the Eco plan

1. Go to your **avatar → Account settings → Billing**.
2. Under **Eco Dynos Plan**, click **Subscribe** and confirm. This is the
   **$5/month** that keeps your robot running. (One small "Eco" plan covers your
   one robot.)

### Step 3 — Set the "container stack" (the one helper step)

The robot uses a built-in web-browser engine, which must be packaged a specific
way. Heroku's website can't flip this switch — it takes one short command.
**This only needs to be done once.** Choose **one** option:

**Option A — Ask your gift-giver to do it (easiest):**
1. In your Heroku app, open the **Access** tab.
2. Click **Add member**, and enter the **Heroku account email** of your gift-giver.
3. Send them your **app name**. They run one 10-second command and tell you when
   it's done.

**Option B — Do it yourself:**
1. Install the Heroku command-line tool — it's an ordinary double-click installer
   (Mac or Windows). Get it from: https://devcenter.heroku.com/articles/heroku-cli
2. Open **Terminal** (Mac) or **Command Prompt** (Windows) and type:
   ```
   heroku login
   ```
   (A browser window opens — log in, then return.)
3. Then type this, replacing `YOUR-APP-NAME` with the name from Step 1:
   ```
   heroku stack:set container -a YOUR-APP-NAME
   ```
   You should see a confirmation that the stack was set to `container`.

> **Do not deploy until this step is finished**, or the build will fail.

### Step 4 — Connect your app to your code

1. In your Heroku app, open the **Deploy** tab.
2. Under **Deployment method**, click **GitHub**, then **Connect to GitHub** and
   authorize it. (You may need to grant Heroku permission to see your repositories.)
3. In the search box, type the name of **the repository you created in Part 1**
   (e.g. `my-tee-booker`) and click **Connect** next to it.
   - *Can't find it?* Make sure you're signed in to the same GitHub account you
     used in Part 1, and that you finished creating your repository.

### Step 5 — Enter your settings

1. Open the **Settings** tab and click **Reveal Config Vars**.
2. Add each row below. Type the **KEY** on the left, the **VALUE** on the right,
   and click **Add** after each one. (Leave `KEEP_ALIVE_URL` out for now — it
   comes in Part 5.)

| KEY                  | VALUE                                                                 |
|----------------------|-----------------------------------------------------------------------|
| `USERNAME`           | Your Scioto member-website username                                   |
| `PASSWORD`           | Your Scioto member-website password                                   |
| `MEMBER_NAME`        | Your name **exactly as ForeTees shows it** (e.g. `John A Smith`)       |
| `TZ`                 | `America/New_York`                                                    |
| `GIST_ID`            | The Gist ID you saved in Part 2a                                      |
| `GIST_TOKEN`         | The token you saved in Part 2b (`ghp_…`)                              |
| `DASHBOARD_PASSWORD` | A password **you make up** — it protects your dashboard. Write it down.|

> Double-check `MEMBER_NAME`. If it doesn't match ForeTees exactly, the robot
> may book the slot but fail to confirm your name on it.

### Step 6 — Deploy

1. Back on the **Deploy** tab, scroll to **Manual deploy**.
2. Make sure the branch is **`main`**, then click **Deploy Branch**.
3. The first build takes **5–10 minutes** — it's downloading the browser engine.
   That's normal. Wait for **"Your app was successfully deployed."**

---

## Part 5 — Finish setup and turn it on (~5 minutes)

### Step 1 — Open your dashboard

Click **Open app** (top-right of the Heroku page). Your dashboard opens and asks
for the `DASHBOARD_PASSWORD` you chose. Enter it.

Look at your browser's address bar and **copy your app's web address** — it looks
like `https://smith-tee-booker-a1b2c3.herokuapp.com`. You need it for the next step.

### Step 2 — Keep the robot awake

The robot must never oversleep the 7 AM window.

1. Back in Heroku → **Settings → Config Vars**, add one final row:

| KEY              | VALUE                                |
|------------------|--------------------------------------|
| `KEEP_ALIVE_URL` | Your full app web address from above |

2. Adding this restarts your app automatically (takes a minute or two).

### Step 3 — Confirm the robot is running

Open the **Resources** tab. You should see a **`web`** line switched **on**. If
it's off, switch it on. (This is what the Eco plan from Part 4, Step 2 pays for.)

---

## Part 6 — Test that everything works (safely)

The dashboard has a **Probe** tab — a **read-only** check. It logs in to ForeTees
with your credentials and walks through the booking screens **without booking
anything**. It's the safe way to confirm your setup.

1. Open your dashboard and click the **Probe** tab.
2. Pick an afternoon time window and click **Run Probe**.
3. Wait a couple of minutes. If it finishes successfully, your login works and
   the robot can navigate ForeTees. **You're all set.**

> ⚠️ The **"Book Now"** and **"Test 7AM"** tabs create **real** tee times on
> ForeTees. Only use them for slots you genuinely want — and cancel on ForeTees
> if you change your mind. For testing, stick to the **Probe** tab.

---

## Part 7 — How to use your robot day to day

### Scheduling a booking

1. Open your dashboard → **Schedule** tab.
2. Enter:
   - **Play date** — must be **8 or more days away** (the robot triggers 7 days
     before, and needs at least a day's notice).
   - **Time window** — the earliest and latest you'd play, e.g. 9:00 to 11:00.
     The robot picks the best open slot inside it.
   - **Member Partners** — other Scioto members, comma-separated.
   - **Guests (Non-Members)** — click **"+ Add guest"** for each non-member,
     enter their name, and pick a **type**: **Family** (your spouse / kids /
     parents / siblings), **Guest**, or **Social Guest**. The type controls
     which ForeTees category they're booked under and which play windows the
     rules engine allows them in. Type **`TBA`** as the name if you don't know
     who yet.
   - **Transport** — cart/walking preference.
3. As you fill the form, a green/amber banner shows whether your time window is
   allowed. If it's restricted, the banner tells you the adjusted window the
   robot will use (e.g. *"Saturday: requested 08:00–09:00 → will book in
   12:00–13:00 per club rules"*).
4. Click to schedule. It appears under the **My Queue** tab.

The robot then fires automatically at **6:58 AM ET, 7 days before your play
date**. You don't need to be awake or online.

### Tips

- **Partners + guests can total 3** (plus you = a foursome).
- For named guests, **pre-add them in ForeTees** beforehand — the robot finds
  pre-added guests most reliably. `TBA` placeholders always work.
- After 7 AM on a trigger morning, check **My Queue** to see whether it booked.
  A green status means success.
- Open the **Club Rules** tab any time to see the current play-window table.
  When Scioto issues a new table, send it to your gift-giver and they'll update
  `rules.json` in your repo.

---

## Troubleshooting

**The build failed.**
You probably skipped Part 4, Step 3 (set the container stack). Set it, then
**Deploy Branch** again.

**The dashboard shows "Application error" or won't open.**
- Check **Resources** tab — the `web` dyno must be **on**.
- Confirm you subscribed to the **Eco plan** (Part 4, Step 2).
- Confirm `USERNAME`, `PASSWORD`, and `MEMBER_NAME` are all set in Config Vars —
  the robot refuses to start without all three.

**A booking didn't happen.**
- Open **My Queue** and read the status and any diagnostics.
- Verify `MEMBER_NAME` matches ForeTees **exactly**.
- Confirm the play date was scheduled **8+ days** out.

**I forgot my dashboard password.**
Heroku → **Settings → Config Vars** → edit `DASHBOARD_PASSWORD`.

**The robot seems to be "asleep."**
Make sure `KEEP_ALIVE_URL` is set to your exact app web address (Part 5, Step 2).

---

## What it costs

| Item            | Cost          |
|-----------------|---------------|
| GitHub          | Free          |
| Heroku Eco plan | ~$5 / month   |
| **Total**       | **~$5 / month** |

Heroku bills the card you added. You can cancel anytime from Heroku's billing page.

---

## Privacy & safety

- Your copy of the robot is **your own private repository** — separate from your
  gift-giver's and from the other recipient's. Nothing they do can affect yours.
- Your Scioto password is stored only as a private **Config Var** on **your own**
  Heroku app. It is never in the code and never visible to anyone who just has
  your dashboard link.
- The `DASHBOARD_PASSWORD` keeps strangers from using your dashboard. Don't share
  your app address together with that password.
- Your booking-storage Gist is **secret**, so your list of bookings isn't
  publicly listed.
- Treat your `GIST_TOKEN` like a password — don't post it anywhere.

---

Enjoy your tee times. ⛳
