/**
 * The user guide, as data.
 *
 * This is the only support channel the person running the daycare has. They
 * will not read docs/, they will not read a commit message, and there is
 * nobody to ask. So it lives inside the app, and it lives HERE rather than in
 * the React component, for one reason: the AI answers questions by quoting
 * these topics, and if the prose the AI reads were a second copy of the prose
 * on screen the two would drift and the AI would confidently describe a CRM
 * that no longer exists.
 *
 * THE RULE: any change to a screen, a button, a permission, a rule or a
 * limitation updates the matching topic IN THE SAME COMMIT. A stale topic is a
 * failing test that nobody notices — it teaches a wrong mental model and then
 * gets blamed for the confusion.
 *
 * Write for somebody who has never seen a CRM. Plain words, real button names,
 * and say what does NOT work as plainly as what does.
 */

export interface HelpTopic {
  id: string;
  section: string;
  title: string;
  /** One sentence, shown in lists and search results. */
  summary: string;
  body: string[];
  /** Numbered, for anything with an order. */
  steps?: string[];
  /** Things that surprise people, and things that will bite. */
  notes?: string[];
  /** Plain-language statement of who can do this. */
  who?: string;
  related?: string[];
  /** Extra words a person might search for that are not in the text. */
  keywords?: string[];
}

export const HELP_SECTIONS = [
  'Start here',
  'Families and children',
  'Every day',
  'Getting people in',
  'Spreadsheets',
  'Money',
  'Running it',
  'What it cannot do',
] as const;

export const HELP: HelpTopic[] = [
  // ------------------------------------------------------------ start here
  {
    id: 'what-is-this',
    section: 'Start here',
    title: 'What this is, in one minute',
    summary: 'A private system for running the daycare: families, children, the daily register, and everything you would otherwise keep in a notebook.',
    body: [
      'Tiny Stars Command Center is the staff side of the nursery. The public website talks to parents; this talks to your team. It holds the families who have enquired, the children who attend, who is in the building today, what needs chasing, and what you spent.',
      'It is private. It is designed to hold records about children, so it is not something to leave open on a shared screen or hand a password out for.',
      'Everything is stored in one file on the computer it runs on. That means it keeps working when the internet does not — the register, the families, search and your tasks are all local.',
    ],
    notes: [
      'If you see an orange "demo data" banner at the top, nothing on screen is real. It is a practice copy, and it is safe to click anything.',
    ],
    related: ['signing-in', 'who-can-see-what', 'the-dashboard'],
    keywords: ['overview', 'introduction', 'start', 'begin', 'what is'],
  },
  {
    id: 'signing-in',
    section: 'Start here',
    title: 'Signing in and out',
    summary: 'Sign in with the email and password you were given. Sign out from the bottom left.',
    body: [
      'Your account is created for you from the command line — there is deliberately no "sign up" page, because anyone who could sign themselves up could read records about children.',
      'If you get the password wrong several times the system pauses sign-in for a short while. This is on purpose, and it counts your account and your office address separately so one person fumbling a password does not lock out everybody else.',
      'Sign out using the button at the bottom of the left-hand menu. On a phone it is behind the menu.',
    ],
    notes: [
      'If you are locked out, wait for the number of seconds it tells you. Trying again immediately restarts the wait.',
      'Ask whoever set the system up to reset your password. Nobody can look up your existing one — passwords are stored scrambled, on purpose.',
    ],
    who: 'Everyone with an account.',
    related: ['who-can-see-what'],
    keywords: ['login', 'log in', 'password', 'locked out', 'forgot', 'sign out'],
  },
  {
    id: 'the-dashboard',
    section: 'Start here',
    title: 'The dashboard',
    summary: 'What is happening today and what needs you, on one screen.',
    body: [
      'The dashboard opens first. The row of numbers across the top is today: tours, new enquiries, registrations, overdue tasks, unread alerts.',
      '"Needs attention" on the right is the important part. It only lists things that are actually a problem — overdue follow-ups, registrations nobody has looked at, tours with no time set. If it is empty, that is a real answer and a good one. It is never padded with zeroes, because a list that always has something in it is a list people stop reading.',
      'Each line links straight to the exact records it counted. Click the number, not a menu.',
      'The command map in the middle is a picture of the system: each blob is a kind of record, sized by how many there are. Click one to go there. If you prefer a plain list, use "Browse as tables" — nothing needs the 3D view.',
    ],
    notes: [
      'Where something has genuinely not been measured, it says "not measured" rather than showing a zero. A zero would mean "we counted and found none", which is a different claim.',
    ],
    related: ['what-needs-attention', 'search-and-shortcuts'],
    keywords: ['home', 'main screen', 'today', 'overview', 'command map', '3d'],
  },
  {
    id: 'search-and-shortcuts',
    section: 'Start here',
    title: 'Finding anything fast',
    summary: 'Press Ctrl+K (or / ) anywhere and start typing a name.',
    body: [
      'The search box at the top searches everything at once: families, children, guardians, enquiries, tours, registrations, tasks and notes. Partial words work — typing "riv" finds "Rivera".',
      'Press Ctrl+K (Cmd+K on a Mac) from any screen to open it without reaching for the mouse. Arrow keys move, Enter opens, Escape closes.',
      'It also lists jump-to actions: today\'s tours, registrations awaiting review, overdue follow-ups, possible duplicate families.',
      'A result always opens the actual record. Searching a child\'s first name opens that child\'s family page, not a list you then have to search again.',
    ],
    who: 'Everyone, but you only ever see records your role is allowed to see.',
    related: ['who-can-see-what', 'the-family-page'],
    keywords: ['search', 'find', 'ctrl k', 'cmd k', 'shortcut', 'keyboard', 'command bar'],
  },

  // ------------------------------------------------- families and children
  {
    id: 'add-a-family',
    section: 'Families and children',
    title: 'Adding a family by hand',
    summary: 'Families → "+ Add a family". A name and one way to contact them is enough.',
    body: [
      'Most enquiries arrive by phone or at the door, so adding a family by hand is a normal thing to do, not a fallback.',
      'Only two things are required: a guardian\'s name, and either an email or a phone number. Everything else can be filled in later. A parent standing at your desk will not have a date of birth to hand, and a form that insists on one is a form people work around by typing nonsense.',
      'You can add more than one guardian, and more than one child, before saving. A family with no child yet is fine — an expecting parent asking about places is still worth recording.',
    ],
    steps: [
      'Open Families from the left menu.',
      'Click "+ Add a family" at the top right.',
      'Type the guardian\'s full name, and an email or phone number.',
      'Add the child\'s first name. If you know their birthday, type it and the age group fills in by itself.',
      'Add a note about the conversation if you want one.',
      'Click "Add family". You land on their page.',
    ],
    notes: [
      'If it looks like a family you already have, it stops and shows you the match before saving anything. Open the existing one, or choose "Add as a separate family" if they really are different. Nothing is written until you decide.',
      'The age group is worked out from the birthday and rechecked every day, so it stays right as the child grows.',
    ],
    who: 'Owner, director and admissions.',
    related: ['the-family-page', 'duplicate-families', 'moving-up-a-room'],
    keywords: ['new family', 'add child', 'manually', 'by hand', 'create', 'enrol', 'enroll'],
  },
  {
    id: 'the-family-page',
    section: 'Families and children',
    title: 'The family page',
    summary: 'Everything about one family in one place, with tabs across the middle.',
    body: [
      'Opening a family shows their name, status, who to call, and the single next action at the top right.',
      'The tabs are Overview, Children, Timeline, Messages, Tours, Registrations, Tasks and Notes.',
      'The Summary on the Overview tab is read from records — how long they have been known to you, how many children, what has happened, what is next. It is marked "from records" precisely so you know nothing was invented. If an AI provider is switched on it can also write a version in prose, and it says so when it does.',
      'The Timeline is the full history in order: the enquiry, contact attempts, the tour, the registration, changes to their details. Every entry says who did it and when.',
      'You can correct details here. "Edit" next to a guardian changes their name, relationship, email, phone, and who the main contact is. "Edit" next to a child on the Children tab changes their name, birthday, age group and status. "+ Add" on either panel adds another.',
    ],
    steps: [
      'Open the family — search their name, or find them under Families.',
      'For a guardian, stay on Overview. For a child, click the Children tab.',
      'Click Edit beside the person, or "+ Add" at the top of the panel.',
      'Change what you need and press Save.',
    ],
    notes: [
      'Call, Email, Write follow-up and Add note are the four buttons at the top. "Write follow-up" drafts a message — it does not send it. See the topic on messages.',
      'Changing a child\'s birthday updates their age group at the same time, so the two can never disagree.',
      'A family has one main contact. Making somebody the main contact takes it off whoever holds it now.',
      'Every correction is recorded on the Timeline with who made it, so a previous value is never actually lost.',
      'If your role cannot see dates of birth, the birthday field is shown as unavailable and leaving it alone cannot wipe the real one.',
    ],
    who: 'Owner, director and admissions can edit. Everyone else can look.',
    related: ['add-a-family', 'messages-are-drafted', 'who-can-see-what'],
    keywords: ['family', 'profile', 'timeline', 'history', 'tabs', 'overview'],
  },
  {
    id: 'duplicate-families',
    section: 'Families and children',
    title: 'Duplicate families',
    summary: 'The system flags likely duplicates and never merges them for you.',
    body: [
      'The same family can arrive twice — a parent submits the website form again, or you add someone who is already there under a maiden name.',
      'When a new record looks like an existing one but is not certainly the same, the CRM creates it separately and raises a task about it. It will not merge on a weak signal like a shared surname, because merging two families that are not the same is much harder to undo than joining two that are.',
      'Families → "Possible duplicates" lists them. When you add a family by hand, the check happens before anything is saved and you are shown the match on the spot.',
    ],
    notes: [
      'A shared surname alone is never enough to link two families. A matching email or phone number is.',
    ],
    who: 'Owner, director and admissions.',
    related: ['add-a-family', 'importing-a-spreadsheet'],
    keywords: ['duplicate', 'merge', 'same family', 'twice', 'double'],
  },
  {
    id: 'who-can-see-what',
    section: 'Families and children',
    title: 'Roles: who can see and do what',
    summary: 'Six roles. An educator cannot see a date of birth or export the family list.',
    body: [
      'Owner — everything, including creating and suspending accounts.',
      'Director — everything except managing accounts.',
      'Admissions — enquiries, families, tours, registrations and tasks. Can see rooms but not mark the register.',
      'Educator — the children in the rooms they are assigned to, and their tasks. No dates of birth, no exporting, no sales pipeline. An educator assigned to no room sees no children at all.',
      'Accounting — families and children read-only, attendance read-only, and can export. Cannot change the register that a bill is based on.',
      'Read only — can look, cannot change anything.',
    ],
    notes: [
      'These limits are enforced by the server, not just hidden in the screen. A role that cannot see a date of birth does not receive it at all — it is not blanked out, it is absent.',
      'Looking at a sensitive record is recorded separately from changing one.',
    ],
    related: ['signing-in', 'privacy-flags', 'exports'],
    keywords: ['roles', 'permission', 'access', 'educator', 'admin', 'who can'],
  },
  {
    id: 'privacy-flags',
    section: 'Families and children',
    title: 'Marking a family private',
    summary: 'Three switches: local only, never send to AI, never sync.',
    body: [
      'Some families need handling differently — a custody arrangement, a safeguarding concern, a parent who asked not to be contacted.',
      'Each family can be marked "local only", "never send to AI" or "never sync". These are real settings stored with the family, not a label. A family marked "never sync" is left out by the query that chooses what to send, so it cannot be included by somebody forgetting.',
      'Marketing and communication opt-outs are checked before any message is queued.',
    ],
    who: 'Owner, director and admissions can change these.',
    related: ['who-can-see-what', 'messages-are-drafted', 'ai-what-it-does'],
    keywords: ['privacy', 'gdpr', 'opt out', 'do not contact', 'sensitive', 'confidential'],
  },

  // ---------------------------------------------------------- every day
  {
    id: 'the-register',
    section: 'Every day',
    title: 'The daily register',
    summary: 'Register in the left menu: who is expected, who is in, who has gone home.',
    body: [
      'The Register is the screen to have open on a tablet in the doorway. The four numbers at the top are: in the building, present today, absent, and not yet marked.',
      '"Not yet marked" is the one that matters at the start of the day — those children have no entry at all, which is different from being marked absent.',
      'Marking a child in records the time and who marked them. Marking them out asks who collected them, and will not continue until you say. That is deliberate: "who took this child home" is the question you need answered later, and a system that lets it be skipped will have it skipped.',
    ],
    steps: [
      'Open Register.',
      'Find the child. The list is grouped by room.',
      'Press In when they arrive.',
      'Press Out when they leave, and record who collected them.',
    ],
    notes: [
      'You can look at another day using the date box at the top right, and get back with "Today".',
      'An educator only sees the rooms they are assigned to. If you see nobody, you are probably not assigned to a room yet — ask the director.',
    ],
    who: 'Educators, directors and owners can mark the register. Accounting can read it but never change it.',
    related: ['rooms-and-ratios', 'moving-up-a-room', 'who-can-see-what'],
    keywords: ['attendance', 'check in', 'check out', 'sign in', 'present', 'absent', 'collected'],
  },
  {
    id: 'rooms-and-ratios',
    section: 'Every day',
    title: 'Rooms, staff and ratios',
    summary: 'Set up rooms, put children in them, assign educators, and record the legal ratio.',
    body: [
      'A room belongs to a program (Twinkle Stars, Comet Stars, and so on). Children are placed in rooms; educators are assigned to rooms.',
      '"Children with no room" lists everyone still waiting to be placed. It is the list to work through once when you first set the system up.',
      'A ratio is one adult per so many children, and it comes from provincial regulation, so you type it in rather than the software assuming it. Until you set one, the room reports "not measured" — it will never show you a reassuring number nobody entered.',
    ],
    steps: [
      'Open Register and find "Rooms and ratios".',
      'Add a room, give it a name and pick its program.',
      'Set the capacity if you know it.',
      'Assign educators to the room.',
      'Under "Supervision ratios", set one adult per how many children for each program.',
    ],
    notes: [
      'Closing a room stops new children being placed in it without deleting any history.',
      'A room with no ratio and a room with a ratio that is being met look different on purpose. "Not measured" is not a pass.',
    ],
    who: 'Owner and director set rooms and ratios.',
    related: ['the-register', 'moving-up-a-room'],
    keywords: ['room', 'classroom', 'ratio', 'capacity', 'staff', 'assign', 'program'],
  },
  {
    id: 'moving-up-a-room',
    section: 'Every day',
    title: 'Children moving up as they grow',
    summary: '"Ready to move up" on the Register lists children who have outgrown their room. It never moves anyone for you.',
    body: [
      'Each program has an age range. When a child grows past the top of the range for the room they are in, they appear under "Ready to move up" with the room that fits, how many places are free in it, and the reason.',
      'Nothing is moved automatically. Moving a child depends on space, on ratios, on the educator they have settled with, and on their parents — none of which the software can see. So it makes the suggestion and waits for you to press the button.',
      'The age group itself is different: that is simply a fact about a birthday, so it is recalculated every day and corrected on its own.',
      '"Birthdays in the next two weeks" is underneath, so nobody is forgotten.',
    ],
    notes: [
      'Only children with a real date of birth appear here. An age group typed by hand is not precise enough to move a child on.',
      'If a room has no age range set, its children are left out and the panel says so rather than quietly skipping them.',
      'Moving a child updates both their room and their program together, so the two can never disagree.',
    ],
    who: 'Owner, director and admissions can move a child. Everyone with register access can see the list.',
    related: ['rooms-and-ratios', 'the-register', 'add-a-family'],
    keywords: ['age', 'birthday', 'move up', 'transition', 'graduate', 'grown', 'outgrown', 'next room'],
  },
  {
    id: 'ages-and-rooms',
    section: 'Every day',
    title: 'Ages & Rooms: where every child should go',
    summary: 'One screen listing every child and the room their age says they belong in.',
    body: [
      'Ages & Rooms is the screen to open when you have just brought a list of children in, or when you want to check nobody has been missed.',
      'It shows every child, not only the ones with a problem, because "everyone is fine" is not believable unless the children who are fine are on the screen too.',
      'Each child gets one of five verdicts: in the right room, should move, needs a room, no room for this age, or no birthday recorded. The filter at the top right narrows it to one of those.',
      'Where a child should move, the button puts them in that room in one click. Nothing moves on its own — that depends on space, ratios, the educator they have settled with, and their parents.',
    ],
    steps: [
      'Open Ages & Rooms from the left menu.',
      'Look at the four numbers at the top: children, in the right room, should move, need a room.',
      'Filter to "should move" or "needs a room" to see just the work.',
      'Press the button beside a child to put them in the room that fits.',
    ],
    notes: [
      'A child with no date of birth cannot be placed here, and the panel at the bottom says how many. Add the birthday on their family page and they appear.',
      'A child outside every age range you have set is also listed. Either you do not run a room for that age, or a program is missing its range — set one on the Register under "Rooms and ratios".',
      'Age groups themselves are recalculated from birthdays every day, so this stays right as children grow.',
      'The age ranges come from the centre’s own licence, and follow the rooms rather than the paperwork where the two differ. Twinkle Stars takes under 12 months up to 19 months (28 places plus 3 allowed under a year). Comet Stars is 19–36 months. Nova Stars covers the whole of pre-school, 3–5 years, because both licensed pre-school ranges are in those rooms. Galaxy Stars runs from 5 years through Grade 6, Kindergarten age and out-of-school care together, which is how the licence counts them and how the room is actually used.',
      'Free places are counted against the room’s own capacity when one is set, and otherwise against the licensed places for that age range — 31 for Twinkle Stars, 76 for Comet Stars, 100 across the Nova Stars rooms, and 74 for Galaxy Stars. 281 places in total.',
    ],
    who: 'Anyone who can see rooms. Owner, director and admissions can move a child.',
    related: ['moving-up-a-room', 'rooms-and-ratios', 'importing-a-spreadsheet', 'lillio'],
    keywords: ['ages', 'rooms', 'placement', 'where', 'which room', 'move', 'assign', 'age group', 'transition', 'plan'],
  },
  {
    id: 'tasks-and-follow-ups',
    section: 'Every day',
    title: 'Tasks and follow-ups',
    summary: 'Every task says why it exists. Many are created for you.',
    body: [
      'Tasks are the things somebody has to do: ring a parent back, review a registration, chase a missing detail.',
      'The CRM creates tasks by itself when something needs a person — a registration arrives, a tour is booked with no time, a possible duplicate turns up. Every automatic task states the reason it was created, so you are never looking at a job with no explanation.',
      'Tasks → "Overdue" and "My tasks" are the two filters worth living in.',
      'You can add your own with "+ Add a task" — for the things no rule will ever notice: ring the plumber, order more wipes, ask a family about a September start. Give it a due date if it matters, and pin it to a family so it shows on their page.',
    ],
    who: 'Everyone can see and complete tasks assigned to them.',
    related: ['what-needs-attention', 'automations'],
    keywords: ['task', 'todo', 'to do', 'follow up', 'reminder', 'chase', 'overdue'],
  },
  {
    id: 'what-needs-attention',
    section: 'Every day',
    title: 'What needs attention',
    summary: 'The panel on the dashboard that only ever lists real problems.',
    body: [
      'It counts overdue follow-ups, overdue tasks, incomplete registrations, registrations nobody has reviewed, tour requests with no time set, tours today, possible duplicates, children who have outgrown their room, and any integration that has failed.',
      'Each row links to exactly the records it counted.',
      'It is empty when nothing is wrong. That is the design — a panel that always shows something is a panel people stop reading.',
    ],
    related: ['the-dashboard', 'tasks-and-follow-ups', 'moving-up-a-room'],
    keywords: ['attention', 'alerts', 'problems', 'radar', 'urgent'],
  },
  {
    id: 'messages-are-drafted',
    section: 'Every day',
    title: 'Messages: the CRM writes, a person sends',
    summary: 'Nothing is ever sent automatically. You read it and press send.',
    body: [
      '"Write follow-up" on a family page prepares a message from a template, filled in with that family\'s details. You edit it and then send it.',
      'Sending is enforced in three separate places: the send only accepts a signed-in person, the database refuses to record a delivery that cannot name who asked for it, and a guardian\'s opt-out is checked before anything is queued. No automation and no AI can reach the send.',
      'Messages go on a queue rather than being sent on the click, so if the mail provider is down your click is not lost and the message is not sent twice.',
    ],
    notes: [
      'Email needs an account to be connected first. Until then the CRM will say "Email is not connected" and name the three settings needed. It will not pretend to have sent something.',
    ],
    who: 'Owner, director and admissions.',
    related: ['privacy-flags', 'integrations-and-health', 'ai-what-it-does'],
    keywords: ['email', 'message', 'send', 'draft', 'reply', 'template', 'contact parent'],
  },

  // -------------------------------------------------- getting people in
  {
    id: 'enquiries-and-pipeline',
    section: 'Getting people in',
    title: 'Enquiries and the pipeline',
    summary: 'Leads move through stages from New to Enrolled, and never backwards by accident.',
    body: [
      'Every enquiry becomes a lead with a stage: New, Contacted, Qualified, Tour requested, Tour booked, Tour completed, Application started, Application submitted, Waitlist, Offered, and the closed ones.',
      'A lead only ever moves forward. If a parent who has already booked a tour sends a contact form, that does not drag them back to New.',
      'Leads → "Overdue" shows anyone whose next action has passed its date. That list is the job.',
    ],
    who: 'Owner, director and admissions.',
    related: ['tours', 'registrations', 'website-enquiries'],
    keywords: ['lead', 'pipeline', 'stage', 'enquiry', 'inquiry', 'prospect', 'funnel'],
  },
  {
    id: 'tours',
    section: 'Getting people in',
    title: 'Tours',
    summary: 'A request is not a booking. Give it a time to confirm it.',
    body: [
      'When a parent asks to visit, that arrives as a tour request with the dates they said they prefer. It is not a booking — you set the actual time, which confirms it.',
      'Tours → "Awaiting a time" is the list of parents waiting to hear back. "Today" is what it says.',
      'After a tour happens, mark it completed. That is what raises the follow-up.',
    ],
    who: 'Owner, director and admissions.',
    related: ['enquiries-and-pipeline', 'website-enquiries'],
    keywords: ['tour', 'visit', 'viewing', 'appointment', 'booking', 'show around'],
  },
  {
    id: 'registrations',
    section: 'Getting people in',
    title: 'Registrations',
    summary: 'Both finished and half-finished registrations arrive here.',
    body: [
      'A registration submitted on the website appears here within seconds, with nobody retyping anything. Sending the same one twice does not create two records.',
      'A registration a parent started and abandoned is kept too, marked incomplete, with how far they got. Those are worth a phone call — the parent was interested enough to start.',
      'Registrations → "Awaiting review" is what nobody has looked at yet.',
    ],
    who: 'Owner, director and admissions.',
    related: ['website-enquiries', 'enquiries-and-pipeline'],
    keywords: ['registration', 'application', 'form', 'signup', 'incomplete', 'abandoned'],
  },
  {
    id: 'the-waiting-list',
    section: 'Getting people in',
    title: 'The waiting list',
    summary: 'Who is waiting, in the order they joined, and who is about to be forgotten.',
    body: [
      'Families sit in the order they joined, within each age group. The number beside a family is their position, and it is worked out fresh every time you open the screen — a saved position would be wrong the moment somebody in the middle left.',
      'The four numbers at the top are the ones that matter: waiting, offered a place, past the deadline, and not heard from. The last two are the whole point of the screen.',
      '"Places, by age group" shows the licensed number, how many children are enrolled, and therefore how many places are actually free. Those are counts, not predictions.',
      'Offering a place records who offered it and by when the family must answer, and raises a task to ring them. If the deadline passes with no answer, that becomes a task too — the place is never quietly taken back.',
      'When they accept, the child is marked enrolled. Which room they go in is decided on Ages & Rooms, because that depends on their age and on space.',
    ],
    steps: [
      'Open the Waiting list.',
      'Deal with anything under "past the deadline" first — those places cannot go to anybody else.',
      'To offer a place, press "Offer a place" and set how many days they have to answer.',
      'When they reply, press "They accepted" or "They said no".',
      'Press "Checked in" whenever you speak to a waiting family. That is what stops them going stale.',
    ],
    notes: [
      'There is no estimated waiting time, on purpose. Nobody can know when a place will free up, and a number on this screen becomes a promise on the phone.',
      '"Sibling here" means that family already has a child attending. It is shown as a fact, not applied as a rule — whether siblings go first is the centre’s policy, and whoever moves somebody up should be able to see they are the one doing it.',
      'A family can turn an offer down and stay on the list, keeping their place. That is for the parent who wanted September and was offered June.',
      'Saying why a family declined is required. It is the only way anybody learns why places go unfilled.',
      'Nobody is removed automatically. An expired offer becomes a phone call, not a withdrawal.',
      'Families are flagged after three months with no contact. Going quiet is the commonest way a waiting list empties itself.',
    ],
    who: 'Owner, director and admissions.',
    related: ['ages-and-rooms', 'registrations', 'lillio', 'enquiries-and-pipeline'],
    keywords: ['waitlist', 'waiting list', 'queue', 'position', 'offer', 'place', 'spot', 'wait', 'list'],
  },
  {
    id: 'website-enquiries',
    section: 'Getting people in',
    title: 'How website enquiries arrive',
    summary: 'The website posts one signed message to the CRM. It never touches the database.',
    body: [
      'The public website does not connect to this database. It sends one signed message to a single address, and that is the whole join between them. Nothing on the website holds a password to this system.',
      'The same submission arriving twice produces one record, so a parent pressing the button again — or the website retrying after a wobble — cannot create duplicates.',
      'If the CRM is unreachable when a parent submits, the parent still sees their confirmation and the submission is retried. A registration is never lost because this system was restarting.',
    ],
    notes: [
      'This has to be switched on by whoever manages the website. Until it is, the CRM works normally and simply receives nothing.',
      'The current live site sends tours to Calendly, registrations to Zoho Forms and the waitlist to Lillio, so those three do not reach the CRM yet. That is a website question, not a CRM one.',
    ],
    related: ['registrations', 'integrations-and-health'],
    keywords: ['website', 'web form', 'ingest', 'webhook', 'online', 'tinystars.ca'],
  },

  // ---------------------------------------------------------- spreadsheets
  {
    id: 'importing-a-spreadsheet',
    section: 'Spreadsheets',
    title: 'Importing your existing list',
    summary: 'Import in the left menu. Excel files are read directly — no saving as CSV first.',
    body: [
      'If your children are already in a spreadsheet, this brings them in without retyping. It handles a few hundred rows in one go.',
      'Excel .xlsx files are read as they are, including workbooks with several tabs — you pick which tab to read. A .csv works too. An older .xls has to be re-saved as .xlsx first.',
      'The import is three steps on purpose, and nothing is written until the last one. You see the exact number of records, which are new, which match someone you already have, and anything that looks wrong — before it happens.',
      'The column matching is done for you from your headings and shown for you to correct.',
    ],
    steps: [
      'Open Import.',
      'Choose your file. If it is a workbook with several tabs, pick the right tab.',
      'Check the columns it matched. Correct any that are wrong.',
      'Press Check the file. Read the counts and any warnings.',
      'Press Import. You get a report of what happened.',
    ],
    notes: [
      'Dates of birth come through as real dates. Excel stores a birthday as a number and only remembers it was a date in the cell formatting, so a naive import turns every birthday into a five-digit number — this one does not.',
      'Warnings about similar surnames are the duplicate check doing its job. It creates them separately and flags them rather than merging.',
      'Formulas in your file are never run. Only the value you can see is read.',
      'Up to 5 MB and 5,000 rows at a time. Split a bigger file.',
    ],
    who: 'Owner, director and admissions.',
    related: ['exports', 'duplicate-families'],
    keywords: ['import', 'excel', 'xlsx', 'csv', 'spreadsheet', 'upload', 'bulk', 'existing list', 'migrate'],
  },
  {
    id: 'lillio',
    section: 'Spreadsheets',
    title: 'Getting your Lillio records into here',
    summary: 'Export from Lillio, drop the file into Import. The columns are recognised for you.',
    body: [
      'If the centre runs Lillio (it used to be called HiMama), its records can come into this CRM and then straight back out as a proper Excel workbook.',
      'It is an export, not a live connection. Lillio does not publish an API for outside software, so nothing can read it automatically — its own help pages point you at the Reports screen. That means this is a job somebody does, not something that happens by itself.',
      'The good news is that the import already knows Lillio\'s column names. Drop the file in and the mapping is filled in for you; you only check it.',
    ],
    steps: [
      'In Lillio, open Reports.',
      'Choose the Child Profile Report, or the Active Enrolment Report if you just want who is attending now.',
      'Pick the centre, the classroom and the child status you want.',
      'Click Run Export and save the CSV it gives you.',
      'In this CRM open Import, choose that file, check the columns it matched, and press Check the file.',
      'Read the counts, then Import.',
      'To get it back out beautifully: Import → Export → "Families, children and guardians".',
    ],
    notes: [
      'Do this every month if you like. Lillio gives you the WHOLE roll each time, including everybody you already imported — and that is fine. A child is recognised by their first name, surname and date of birth together, so re-importing the same export adds nobody twice. The preview tells you before you commit: "0 to create, 134 to update" means everyone is already here.',
      'Next month\'s file adds only the new starters. Children who have left simply stop appearing in the export; they are not removed from the CRM, because a record of a child who used to attend is worth keeping.',
      'The Active Enrolment Report is a roster: First Name, Last Name, Date of Birth, Classroom, Enroll Date, and no parents at all. That is fine — the children come in, each family is named from the child, and you add guardians afterwards from the family page. The import warns you about every family with no contact details so none are forgotten.',
      'After importing a roster, open Ages & Rooms. It will show every child as needing a room, with the room their age fits, so you can place them all from one screen.',
      'Lillio also has an Enrolment Report and billing reports, which export the same way.',
      'If a live connection matters, ask Lillio directly whether your account can have API access. Until somebody says yes, nothing here will pretend to have it.',
      'The centre\'s waitlist page on the website still sends parents to Lillio. Do not switch that off before deciding what replaces it — families are part-way through applications in it.',
    ],
    who: 'Owner, director and admissions.',
    related: ['importing-a-spreadsheet', 'exports', 'website-enquiries'],
    keywords: ['lillio', 'himama', 'transfer', 'migrate', 'move data', 'sync', 'connect', 'existing system'],
  },
  {
    id: 'exports',
    section: 'Spreadsheets',
    title: 'Getting your data out',
    summary: 'Proper Excel workbooks with coloured tabs, or a plain CSV if another system needs one.',
    body: [
      'Import → Export offers two workbooks. "Families, children and guardians" has a summary sheet plus a sheet each for families, children and guardians. "Admissions" has the funnel, where enquiries came from, tours, registrations and the waitlist — and contains no child\'s name, so it is the one to take into a meeting.',
      'The logbook has its own workbook, on the Logbook screen.',
      'They are real spreadsheets: frozen headings, filters, dates and money formatted, and totals that add up. A plain CSV is still there for feeding another system.',
    ],
    notes: [
      'If your role cannot see dates of birth, the column is not in the file at all. It is not blanked — a blanked column is still in the file and can be un-hidden by whoever you send it to.',
      'Every export is recorded in the access log with who did it and how many rows.',
      'The families file identifies children. Treat it like a paper file: do not email it around, and delete it when you are done.',
    ],
    who: 'Owner, director and accounting. Educators cannot export.',
    related: ['importing-a-spreadsheet', 'who-can-see-what', 'the-logbook'],
    keywords: ['export', 'download', 'excel', 'xlsx', 'csv', 'report', 'spreadsheet', 'print'],
  },

  // ---------------------------------------------------------------- money
  {
    id: 'the-logbook',
    section: 'Money',
    title: 'The logbook: what you spent',
    summary: 'Type what you bought in an ordinary sentence and it is written down properly.',
    body: [
      'Type something like "spent 42.50 at Costco on snacks yesterday" and the amount, the date, the supplier and the category are read out of it. If the sentence did not say something, it asks you once rather than guessing.',
      'What you actually typed is kept next to what was understood from it, so a bad reading can be corrected against your original words.',
      'You can speak instead of typing, using your browser\'s own speech recognition. There is no charge for it and the microphone only appears where it works.',
      'Entries can be corrected, and removed. A removed entry leaves the lists and the totals but the record of it stays, so a total can never quietly stop matching the receipts. You can put it back.',
    ],
    steps: [
      'Open Logbook.',
      'Type or say what happened, in an ordinary sentence.',
      'Answer anything it asks about, then save.',
    ],
    notes: [
      'Several purchases in one sentence: "I bought milk for $12 and nappies for $30 at Costco on September 2" becomes two entries. That split needs an AI provider switched on; without one it is read as a single entry. Either way nothing is saved until you have looked at it — the amounts and dates are always re-read by the rules, never taken from the AI.',
      'If a sentence names money, it is recorded as a purchase even when there is no word like "bought" in it. "I put fuel in the car, $60" used to be filed as a note and left out of every total.',
      'Amounts are understood with the currency on either side: "$50", "50 usd", "40 cad", "12 dollars".',
      'The reading is done by rules, not by AI. An amount and a date are exactly specified things, and a rule gets them right every time.',
      'Totals for a range with nothing in it say "not measured" rather than a confident zero.',
    ],
    who: 'Owner, director and accounting.',
    related: ['exports'],
    keywords: ['logbook', 'expense', 'spend', 'money', 'receipt', 'grocery', 'shopping', 'cost', 'petty cash', 'voice'],
  },

  // ----------------------------------------------------------- running it
  {
    id: 'automations',
    section: 'Running it',
    title: 'Automations',
    summary: 'Rules that create tasks and reminders for you. Readable, changeable, and switchable off.',
    body: [
      'Automations do the remembering: raise a task when a registration is not reviewed, chase a tour that was never confirmed, flag a follow-up that has gone past its date.',
      'Every rule is written in plain language on the Automations screen. You can see when each last ran and what it did, run one by hand, or switch it off.',
      'There is a single switch that disables all of them at once.',
    ],
    notes: [
      'No automation can send a message to a parent. They create work for people; a person still does it.',
    ],
    who: 'Owner and director.',
    related: ['tasks-and-follow-ups', 'messages-are-drafted'],
    keywords: ['automation', 'rule', 'automatic', 'workflow', 'trigger', 'reminder'],
  },
  {
    id: 'backups',
    section: 'Running it',
    title: 'Backups',
    summary: 'Taken daily, kept for two weeks, and tested rather than assumed.',
    body: [
      'A backup is taken every day and the last fortnight is kept. Each one is checked after it is written — opened, and the row counts compared against the live database.',
      'That check matters. A backup that exists but cannot be restored is worse than no backup, because you stop worrying about it.',
      'You can take one by hand and test restoring one from the System screen.',
    ],
    notes: [
      'The whole system is one file. Whoever manages the computer should also copy the backups somewhere else — a fire does not care how good the backup routine was.',
    ],
    who: 'Owner and director.',
    related: ['integrations-and-health'],
    keywords: ['backup', 'restore', 'safety', 'lost data', 'recover'],
  },
  {
    id: 'integrations-and-health',
    section: 'Running it',
    title: 'System health and connections',
    summary: 'The System screen tells you honestly what is connected and what is not.',
    body: [
      'System shows the database, migrations, backups, the outbound queue, website intake, and each connection.',
      'Anything not connected says so and names exactly what is missing. It never shows green for something that has not been set up — a green light you cannot trust is worse than a red one.',
      'The outbound queue retries with increasing gaps and eventually gives up rather than retrying forever. Anything that fails ends up somewhere a person looks, not in a log file.',
    ],
    notes: [
      'Google Sheets and email are both built and waiting only for account details. That is a setup step, not missing software.',
    ],
    who: 'Owner and director.',
    related: ['backups', 'messages-are-drafted', 'not-built-yet'],
    keywords: ['system', 'health', 'status', 'connection', 'integration', 'google', 'sheets', 'error', 'failed'],
  },
  {
    id: 'ai-what-it-does',
    section: 'Running it',
    title: 'The AI, and what it is not allowed to do',
    summary: 'Off unless switched on. It can summarise and draft; it can never send, and it cannot invent numbers.',
    body: [
      'The CRM works completely with AI switched off. Not reduced — off. Everything has a plain, rule-based version, and that is what ships by default.',
      'When a provider is configured it can summarise a family, write a morning briefing, draft a reply, and answer questions in this Help using only what the Help actually says.',
      'It reads a filtered view. The filter runs before anything leaves the system, so an educator cannot obtain a date of birth by asking the AI nicely.',
      'It separates what it read from what it inferred, and says when there is not enough information rather than filling the gap.',
      'It can run entirely on the same computer, with no data leaving the building. A cloud provider is a separate, deliberate choice that has to be switched on.',
    ],
    notes: [
      'AI never sends a message to a parent. It drafts; a person sends.',
      'A family marked "never send to AI" is left out of every AI request.',
      'Numbers on the dashboard are counted from records, never written by an AI.',
    ],
    who: 'Owner and director can configure it.',
    related: ['privacy-flags', 'messages-are-drafted', 'using-this-help'],
    keywords: ['ai', 'artificial intelligence', 'ollama', 'chatgpt', 'summary', 'briefing', 'assistant'],
  },
  {
    id: 'using-this-help',
    section: 'Running it',
    title: 'Using this Help',
    summary: 'Search it, browse it, or ask a question in your own words.',
    body: [
      'Type a question into the box at the top of this screen and it finds the topics that answer it. That search always works, with or without AI.',
      'If an AI provider is switched on, it will also write a short answer in its own words — but only from what these topics say. It will tell you when the Help does not cover something instead of making something up.',
      'This Help is kept in step with the software deliberately: a change to a screen updates the matching topic at the same time.',
    ],
    related: ['ai-what-it-does', 'not-built-yet'],
    keywords: ['help', 'guide', 'manual', 'how to', 'ask', 'question', 'support', 'documentation'],
  },

  // ----------------------------------------------------- what it cannot do
  {
    id: 'not-built-yet',
    section: 'What it cannot do',
    title: 'What is not built yet',
    summary: 'Stated plainly, because a greyed-out button that implies otherwise is worse than an honest gap.',
    body: [
      'Documents, incidents and staff records — no file store, no incident log, no certificate expiry tracking yet.',
      'Billing and invoicing. The logbook records what you spend; it does not bill parents.',
      'Facebook, Instagram and WhatsApp. This is not a coding gap: it needs Meta business verification and app review on your own account, which is an approval process taking weeks. Nothing will pretend to be connected in the meantime.',
      'A calendar connection, and two-way Google Sheets syncing. Sheets can already send outward once connected.',
      'Asking questions in plain language across your records — you can search, and the AI can summarise a family, but it cannot yet answer "show me everyone who toured but did not register".',
      'Sharing between devices. The system runs on one computer at a time.',
      'Voice agents answering the phone.',
    ],
    notes: [
      'The System screen shows this same list inside the app, so it can be checked rather than remembered.',
    ],
    related: ['integrations-and-health', 'ai-what-it-does'],
    keywords: ['missing', 'not built', 'roadmap', 'coming', 'limitations', 'cannot', 'instagram', 'facebook', 'whatsapp', 'billing', 'invoice'],
  },
  {
    id: 'something-went-wrong',
    section: 'What it cannot do',
    title: 'When something goes wrong',
    summary: 'What the common messages mean, and what to do.',
    body: [
      '"Cannot reach the Command Center server" — the program is not running, or the computer it runs on is off. Nothing is lost; it is all in the file on that machine.',
      '"Too many sign-in attempts" — wait the number of seconds it names. Trying again straight away restarts the wait.',
      '"That child is not in a room you are assigned to" — you are an educator and that child is in somebody else\'s room. Ask the director to assign you.',
      '"Google is not connected" or "Email is not connected" — a setup step, not a fault. The message names exactly which settings are missing.',
      'A registration that never arrived — check System, where failed intake is listed with the reason. It is never silently dropped.',
    ],
    notes: [
      'You will not be shown a raw technical error. If a message does not tell you what to do next, that is a fault worth reporting.',
    ],
    related: ['integrations-and-health', 'backups', 'signing-in'],
    keywords: ['error', 'problem', 'broken', 'not working', 'fix', 'trouble', 'help me', 'failed'],
  },
];

// ------------------------------------------------------------------ search

/**
 * Words that appear in almost every topic and so carry no signal.
 *
 * Without this, "something is broken" scores every topic containing the word
 * "is" — which is all of them — and buries the troubleshooting page under
 * whichever topic happens to be wordiest. People type whole questions, not
 * keywords, so the filler has to be discarded.
 */
const STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'that', 'this',
  'have', 'has', 'from', 'they', 'it', 'is', 'be', 'do', 'does', 'did', 'can',
  'how', 'what', 'when', 'where', 'who', 'why', 'my', 'me', 'we', 'us', 'a', 'an',
  'to', 'of', 'in', 'on', 'at', 'by', 'or', 'if', 'so', 'as', 'was', 'were',
  'get', 'got', 'see', 'use', 'using', 'about', 'there', 'here', 'some', 'any',
]);

/** Deterministic search over the topics. Works with AI switched off, which is
 *  the point — this is the baseline every install has. */
export function searchHelp(query: string, limit = 6): HelpTopic[] {
  const all = query.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 2);
  const meaningful = all.filter((t) => !STOP.has(t));
  // A question made entirely of filler still deserves an attempt rather than
  // a blank screen, so fall back to what they typed.
  const terms = meaningful.length ? meaningful : all;
  if (!terms.length) return [];

  const scored = HELP.map((topic) => {
    const title = topic.title.toLowerCase();
    const summary = topic.summary.toLowerCase();
    const keywords = (topic.keywords ?? []).join(' ').toLowerCase();
    const body = [...topic.body, ...(topic.steps ?? []), ...(topic.notes ?? [])]
      .join(' ').toLowerCase();

    let score = 0;
    for (const t of terms) {
      // Weighted so a word in the title beats the same word buried in prose.
      if (title.includes(t)) score += 10;
      if (keywords.includes(t)) score += 6;
      if (summary.includes(t)) score += 4;
      if (body.includes(t)) score += 1;
    }
    return { topic, score };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.topic);
}

/** The topics as plain text, for grounding an AI answer. Nothing else is sent. */
export function topicsAsContext(topics: HelpTopic[]): string {
  return topics.map((t) => [
    `## ${t.title}`,
    t.summary,
    ...t.body,
    ...(t.steps?.length ? [`Steps: ${t.steps.join(' ')}`] : []),
    ...(t.notes?.length ? [`Note: ${t.notes.join(' ')}`] : []),
    ...(t.who ? [`Who can do this: ${t.who}`] : []),
  ].join('\n')).join('\n\n');
}
