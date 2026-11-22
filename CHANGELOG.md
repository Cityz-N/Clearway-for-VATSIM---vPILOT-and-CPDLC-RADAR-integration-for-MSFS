# Changelog

## 1.3.0

- MSFS panel: the card has the same height on every tab (vPilot, CPDLC, SELCAL and the notepad), so switching tabs doesn't make it jump. It starts small and grows with your vPilot and CPDLC messages, up to the height of the vPilot tab with six controllers in the ATC list, and every tab follows (the Radar too); past that, lists scroll inside. Grey status lines ("Connecting...", "Connected to VATSIM", "Connected to Hoppie"...) don't make it grow
- Radar: a new **expand** button next to the detach button switches between the compact radar (the card's size) and the big one (twice as wide, taller), remembered. In its own window it switches the window between a card-sized and the big size (the corner grip still resizes it freely)
- MSFS panel: the SELCAL generator (callsign, codes, Generate / Save / Use in vPilot) folds away under a **Generate** header, like CPDLC's Request, closed when the panel starts. Checking a code stays visible; SimBrief opens the generator
- MSFS panel: a glass look for the card and the peek: 75% opaque backgrounds, so the sim shows through while text and buttons stay solid, and a faint white rim instead of the outline and shadow. The Radar tab stays fully opaque
- Radar: the info card of an aircraft, controller or airport shows its close button (×) at the top right; the frequency or callsign used to cover it
- Radar: each controller and ATIS in a card can be folded to just its callsign and frequency: click its callsign line (small arrow on the left), again to unfold. Handy on a busy airport whose card covered the map
- MSFS panel: the mouse wheel over the card, the peek, the radar window or the icon is kept by the panel (it scrolls the list under the mouse itself), to stop it reaching the cockpit, e.g. turning a knob while the camera is moving. MSFS may still route the mouse to the cockpit while the camera moves
- MSFS panel: the LT clock shows the real local time where your aircraft is (flying in California from Paris: California time), not your PC's time. It doesn't follow the time of day set in the sim
- MSFS panel: the green vPilot power button now also closes vPilot, after a "Close vPilot?" confirmation (Close / Cancel, gone after 8 seconds). vPilot is asked to close like clicking its X, so it disconnects and shuts down normally. With "Quit Clearway when vPilot closes" on, Clearway quits too, as when you close vPilot yourself
- MSFS panel: the start-up window colour is a softer mint green (#86efac) instead of the electric yellow-green, on the icon and the countdown ring
- MSFS panel: during the start-up window (TSAT -5 to +6, full green icon or countdown ring), a right click on the icon shows "Start-up window" with a live "MM:SS left" countdown to its end, once no message is waiting: unread messages come first, including new frequency text for others, which a right click now also shows and marks read. Click the countdown to open the card
- MSFS panel: the countdown (ring and timer) fades from mint green through yellow and orange to red as the start-up window runs out
- MSFS panel: the TSAT countdown ring is the size of the icon again (in 1.2.0 it showed up far too big next to the icon in the sim)
- TSAT clock: Clearway checks the CDM data every 2:30 instead of every 3 minutes (until a TSAT is set and your flight is activated; once a minute with a CTOT, as before)
- TSAT clock: once your flight is activated (off blocks), the clock goes back to your usual one. Before, it kept counting up in red past the window while you taxied, until take-off
- vPilot connect form (panel and phone): the aircraft type and SELCAL come from your VATSIM flight plan, found by your VATSIM CID (your prefile before you connect), else from your last connection. A value you typed yourself is never replaced. Clearway reads the VATSIM data at most once a minute for this, only while vPilot is open or the panel is showing
- SELCAL tab (panel and phone): when your SimBrief plan has no SELCAL, the one in your VATSIM flight plan is shown; without SimBrief, your VATSIM flight plan (callsign, route, type, SELCAL) is shown instead
- CPDLC: a **ROGER** button for text from ATC (panel, peek and phone). Text that needs an answer shows ROGER next to STANDBY (before, only STANDBY, so you had to type ROGER); text that needs none (e.g. "APPROVED. REPORT BACK") gets an optional ROGER, and you can still just mark it read. Logon and unit notices get none
- MSFS panel: slim scrollbars you can drag (or click to jump) on the vPilot chat, the ATC list, the CPDLC messages, the SELCAL tab and the notepad. MSFS shows no scrollbars in panels, so only the mouse wheel worked
- MSFS panel: vPilot action messages ("Connecting...", errors) float just above the message box instead of being cut off at the bottom of the card
- MSFS panel: slimmer SELCAL headers, so the whole tab fits when it opens
- Radar: on the compact radar the map credits are shorter and smaller, and the expand button shows arrows (out to make it bigger, in to make it smaller)
- MSFS panel: right clicking the peek to close it also marks its message read (also when the peek had brought back your last message as unread)
- CPDLC: a logon is also confirmed when the station answers with CURRENT ATC UNIT instead of LOGON ACCEPTED (some controller software does, e.g. BIRD): it shows as a message from the station, answers your LOGON request and stops it waiting. Before, nothing appeared and the request stayed "awaiting"

## 1.2.0

- MSFS panel: a small power button right of Connect / Disconnect in the vPilot tab. Red while vPilot is closed: click it to start vPilot minimized in the background, without leaving the sim. Green once vPilot is open. Clearway finds vPilot where it's installed (or where it last saw it running)
- MSFS panel: new messages colour only a quarter of the icon, under their counter, fading towards the centre: cyan top left for vPilot, amber top right for CPDLC (before, the whole icon turned cyan or amber). With the card closed, the rest of the icon fades away and only those colours and counters stay until you hover it. The icon's speech bubble and thin border are now a blue that matches the navy Dark theme. The faint icon (connected, nothing for you) is colourless in all three themes: pure grey, no blue tint. The small grey dot (bottom left) for new vPilot text that isn't for you now works: it never came on for frequency text to other pilots (only for broadcasts), and it was nearly invisible on the faint icon. It goes away when you look at the frequency chat (panel or phone)
- CPDLC: LOGON ACCEPTED arrives as a message from the station (icon colour, phone notification), and your LOGON request shows it as its answer. Before, the only confirmation was a small grey "Logged on to ..." line that was easy to miss
- MSFS panel: right click the peek (the message preview next to the icon) to close it
- MSFS panel: the vPilot and CPDLC tabs grow with their messages only up to the radar's height, then the messages scroll; before, the card grew taller with every message
- MSFS panel: the COM radios popup over the FREQ chip is no longer cut off at the card's right edge, and shows only the active frequencies (no standby)
- MSFS panel: when Clearway isn't running, the faint icon is red (it was yellow, like "not on VATSIM"), and the vPilot and CPDLC tabs say "Clearway not running" with a red dot. With vPilot open, a **Start** button next to it starts Clearway in the background through the vPilot plugin; it turns green while Clearway starts and goes away once it's running. Needs the new vPilot plugin (copy the new Clearway.vPilot.dll into vPilot's Plugins folder) and Clearway started once by hand, so the plugin knows where it is
- MSFS panel: after the start-up window alert, a yellow-green ring around the icon counts down the rest of the window: it retracts counterclockwise and is gone when the window closes (TSAT +6), then the ring turns electric orange. It stays until your flight is activated on the network (off blocks). Clearway keeps checking the CDM data every 3 minutes until then. The ring is drawn on a canvas at high resolution: in MSFS an SVG ring didn't count down (always full) and looked pixelated
- Radar: US airports are one airport again. Controllers log in as LAX_TWR while the ATIS is KLAX_ATIS, so the radar showed two airports on the same spot: "LAX" with the controllers but no name and no departures/arrivals, and "KLAX" with only the ATIS. Now they're all under KLAX, with its name and the DEP / ARR box
- Radar: a controller's information is shown in full, one line per line as they wrote it (it was cut after two lines unless you clicked it). Only an ATIS is still folded to two lines, with a "Show full ATIS" link. A card taller than the radar scrolls
- vPilot ATC list (panel and phone): a controller's information now shows their name at the top right, as they chose to show it on VATSIM (full name, first name or CID). It comes from the VATSIM data, since vPilot doesn't give names
- SELCAL tab: when your SimBrief flight plan has no SELCAL, it shows the SELCAL you connected to VATSIM with (if any)
- Phone: notices within 5 seconds when Clearway closes ("Clearway not running on the PC"); before, it could keep showing the old state for minutes, because Windows' firewall drops the requests silently instead of refusing them
- TSAT clock: also works when no CDM controller is online. There's no TSAT then, only the TOBT you submitted, so the clock counts down to the suggested start-up window around your TOBT (hover it for details) and keeps checking every 3 minutes in case a controller comes online with a real TSAT
- TSAT clock: fixed the clock not showing or not updating your TSAT. The CDM network now sends its times with seconds (214500 instead of 2145), which Clearway didn't recognise, so it ignored your TSAT
- TSAT clock: the window now matches the VDGS page, TSAT -5 to TSAT +6 (e.g. 2355-0006z for 0000z): green up to +5:59, then red
- Radar: aircraft above 18000 ft that are level show a round flight level (FL360 instead of FL358): VATSIM reports true altitude, which drifts with temperature. Climbing or descending aircraft keep the exact value; the exact altitude stays in the aircraft's details

## 1.1.0

- New **TSAT clock** in the MSFS panel. After you submit your TOBT on the VDGS website (vats.im/vdgs), Clearway reads your start-up time from the vIFF / CDM network and the clock becomes a countdown: yellow while it counts down to the opening of the start-up window, then green from -5:00 to 0:00 (your TSAT) and up to +5:00, then red. Hover it for TSAT, window, TOBT, TTOT and CTOT. Click it to switch to the other clocks as before; it switches to the TSAT clock by itself when a new TSAT arrives and goes back to your usual clock after take-off or when you disconnect
- TSAT clock: when the start-up window opens, the floating icon turns electric yellow-green until you open the card or click the clock (not while notifications are muted)
- Phone: the home-screen app no longer stops connecting when your PC gets a new address on the Wi-Fi (new DHCP lease, Windows' random hardware addresses). After scanning the QR code, the page switches to your PC's name (http://your-pc-name.local:8787) when the phone can find it, and that address stays valid. Phones that can't use .local names stay on the IP as before. Scan the QR code once more and add the page to the home screen again after it says "Now using your PC's name"
- Only one Clearway can run at a time: starting it again shows "Clearway is already running" (before, a second copy could start and share the same port)
- Clearway quits by itself when vPilot closes (10 seconds after), if vPilot ran while Clearway was open. Clearway on its own (CPDLC only) keeps running. Settings > "Quit Clearway when vPilot closes" switches it off
- Phone: connecting through the PC's name is faster: Clearway hangs up at once on Safari's https attempt (Safari tries https first for names), and keeps the phone's and the panel's connection open between updates instead of opening a new one every 1.5 s
- Phone: fixed pairing that sometimes failed after a Clearway update: the page loaded but never connected, because the iPhone reused scripts cached from the older version. Scripts and styles now get a new address with every version
- Phone: the pairing QR code and the notification links always use the PC's current address (it was taken once when Clearway started, so it went stale when the Wi-Fi reconnected with a new IP while Clearway was running)
- Radar: each airport with controllers shows a dot with its controller badges underneath and its name above (zoomed in); airport names for traffic are also above their dot
- MSFS panel: the callsign shown when hovering the faint icon is white
- New **Dark** theme colours (navy, #050e17) and a new **Black** theme. Settings > Theme: Dark, Black or Light (phone, PC and MSFS panel)
- TSAT clock: Clearway only asks while vPilot is connected (not as an observer) and you're on the ground with a flight plan: once every 3 minutes until a TSAT is set, then no more, or once a minute if your flight has a CTOT. Only your own flight is kept. It needs your VATSIM CID in Settings, which is sent as the request's User-Agent. It can be switched off in Clearway's settings
- MSFS panel: accents and symbols no longer show as empty boxes in MSFS 2024. The panel and the radar now use the bundled Selawik font (Microsoft's open version of Segoe UI, SIL Open Font License)
- MSFS panel: the floating icon turns cyan only for vPilot messages meant for you (private messages, SELCAL, frequency text with your callsign). Other unread messages (broadcasts) show a small grey dot at its bottom left. Hover the faint icon to see your callsign
- MSFS panel: the faint icon is yellow while you're not connected to VATSIM
- MSFS panel: the notepad shows your callsign at the top right
- Radar: the info windows (airport, controller, pilot) are about a third smaller: the airport name is on the ICAO line and each controller's information is cut to two lines (click it to read it all)
- Radar: departures and arrivals have their own slim box at the bottom right (the same height as the pilot count) while an airport is selected: a red circle (departures) and a green circle (arrivals) with the counts. Click one to show or hide its lines; filled means shown
- Radar: fixed an error when the controller data wasn't ready yet

## 1.0.0

- New **Radar** tab in the MSFS panel: live VATSIM traffic on a dark map. Planes show their callsign and type with the destination underneath; click one for the full tag (frequency it's tuned to, altitude, speed) and its details. Planes on the ground appear when zoomed in to airport level
- Radar: online controllers with their sectors from VATGlasses (coloured areas with callsign and frequency), airport badges for Delivery / Ground / Tower / Approach / ATIS, and approach circles where VATGlasses has no data. Click a sector or airport for the controllers, frequencies and ATIS
- Radar: airports with arriving traffic show as small dots; click an airport for red departure and green arrival lines (each can be switched off)
- Radar: your own aircraft is green when you're connected (Clearway knows your callsign from the vPilot plugin), or a hollow green outline at your sim position when you're offline or an observer. The target button centres the map on you (click once), then keeps tracking you (click again)
- Radar: on the Radar tab the card is twice as wide. The detach button opens the radar in its own window that you can move and resize (it stays open when the card is closed); dock it back with the button in its title bar or "Put it back here" in the tab
- Radar: buttons for labels, ATC and display size (AUTO / 1080p / 1440p / 4K). The buttons and the map credits keep the same size whatever the display size
- Radar: nothing is downloaded or drawn while the radar is hidden; its data (about 120 MB of memory) only loads the first time you open it. Map: Esri World Dark Gray Canvas; sectors: VATGlasses (CC BY-NC-SA 4.0); airports: VATSpy data project (CC BY-SA 4.0)
- MSFS panel: the card is a little wider so its header fits all four tabs, the clock and the buttons (with four tabs the notepad and collapse buttons were cut off)
- Radar: smooth dragging and zooming in MSFS 2024 (the map is moved on screen while you drag and redrawn when you stop), no more gaps between map tiles, and new map areas load about twice as fast
- Radar: the detached radar window stays under the Clearway card
- MSFS panel: the floating icon turns solid when a message arrives instead of flashing, and is fully visible for the first 10 seconds so it's easy to find
- MSFS panel: right click on the icon works in MSFS 2024 (peek at the latest message, CPDLC replies, WX)
- MSFS panel: Tab / Shift+Tab move between text boxes
- MSFS panel: new mute icon for notifications and a rotation-lock icon for the card direction
- MSFS panel: fixed a drawing glitch in MSFS 2024 when the card changed size (deleted messages, request form)
- vPilot: Nearby ATC on the left of the chat tabs (its count stands out when controllers are online), frequency on the right; hover the frequency for TX / RX on each radio
- vPilot: Mode C, Standby and Ident now also set the aircraft's transponder in the sim, which vPilot follows (from the panel and the phone)
- vPilot: the SELCAL in the connect form is always written AB-CD
- vPilot: as an observer you can only send private messages, not frequency text
- vPilot: the FP status badge is red with a cross when no flight plan is filed on VATSIM and green with a tick when it is
- vPilot: "vPilot not opened / plugin not found" when Clearway can't reach vPilot
- CPDLC: Hoppie status in the CPDLC tab (green tick connected, red cross not); click it to type or paste your logon code. The code and your SimBrief ID are hidden on screen
- CPDLC: a logon request with no answer after 10 minutes is cancelled
- SELCAL: the VATSIM flight plan count is no longer shown in the bar

## 0.9.8

- Fixed: fetching the SimBrief flight plan failed with "invalid literal for int()" (SimBrief now sends the plan's time as a date)
- Fixed: your own flight plan or prefile no longer shows your SELCAL as "Used by" yourself (your vPilot callsign, your SimBrief callsign and the callsign in the SELCAL tab are ignored)
- MSFS panel: the SimBrief username box keeps lower-case letters instead of showing everything in capitals
- MSFS panel: your SimBrief username or pilot ID is shown in the SELCAL bar next to the SimBrief button; click it to change it (the box opens with the current one selected, Fetch saves the new one, click again to cancel)

## 0.9.7

- vPilot connect form: under the callsign box, **SB: CALLSIGN** shows the callsign of your latest SimBrief flight plan, to catch typos. It turns green when what you typed matches and amber when it doesn't; click it to use that callsign. The small refresh icon next to it fetches your latest SimBrief plan again (panel and phone)
- The SimBrief plan is fetched automatically the first time you open the connect form (once your SimBrief username is set in the SELCAL tab)

## 0.9.6

- vPilot connect form: a small line under the SELCAL field checks the code on VATSIM as you type: "check. avail..." while checking, then **avail.** in green or **taken by CALLSIGN** in red (panel and phone)
- MSFS panel: play/pause button in the top-right icons to pause panel notifications. While paused, the floating icon stays faint and quiet (no flashing, colour or counters) and shows a small pause mark; Clearway also stops muting your phone, so messages still reach you there. Click again to resume
- MSFS panel: the card is slightly wider to fit the extra button

## 0.9.5

- New **SELCAL** tab (MSFS panel, phone and PC), merged from the SELCAL code generator: standard (16-tone) and extended (32-tone) codes, airline name and logo, save codes for 24 hours (up to 10 per callsign), shared between the panel, phone and PC
- SELCAL: generated codes are checked against every flight plan on VATSIM (online and prefiled), so you never get a code someone else is using. Each code shows "Free on VATSIM" or who uses it
- SELCAL: **SimBrief** button reads your latest SimBrief flight plan and shows its SELCAL, with the same VATSIM check (enter your SimBrief username or pilot ID once)
- SELCAL: "Use in vPilot" puts the code in vPilot's connect form
- SELCAL: "Check a code": type any code to see if it's valid and whether anyone on VATSIM uses it, then save it or use it in vPilot
- SELCAL: the "Free / Used by" lines refresh by themselves whenever Clearway reads new VATSIM data (every minute while vPilot is connected)
- vPilot: a bold **FP status** warning appears next to your callsign when you're connected but VATSIM has no flight plan filed for it (or only a prefile)

## 0.9.1

- MSFS panel: fixed the card sometimes opening partly off screen (mostly with the icon near the bottom or top edge) until the icon was moved. The card now keeps itself on screen whenever its content or the window changes size

## 0.9.0

- MSFS panel: while you type in a panel text field, the keys no longer reach MSFS key bindings or other programs such as ChasePlane, so typing doesn't move the camera or trigger sim commands. Clearway holds the keyboard and types into the panel itself. Controllers keep working, and function keys, Alt+Tab and the Windows key work as usual
- The keyboard goes back to the sim on Esc, a click outside the panel, 15 seconds without typing, or if the panel stops answering
- Text editing in the panel: arrows (Up/Down move between lines in the notepad), Home/End, Shift to select, Ctrl+A, Ctrl+V (paste from Windows), Ctrl+Backspace, accents and dead keys follow your keyboard layout
- New setting to switch this off (Options: "MSFS panel: keep typed keys away from the sim and other programs")

## 0.8.0

- vPilot: "Connect as observer" tickbox in the connect form (panel and phone). An observer only needs a callsign; Clearway shows "(observer)" and greys out the transponder buttons
- vPilot: an observer connection now counts as connected (it used to show "vPilot offline"), and doesn't start the automatic Hoppie connection
- MSFS panel: clicking anywhere outside the panel (cockpit, scenery, another window) now takes the cursor out of the notepad and message boxes straight away. The click still reaches the sim as normal
- vPilot plugin 0.5.0 (needed for observer mode: copy the new Clearway.vPilot.dll into vPilot's Plugins folder)

## 0.7.0

- MSFS panel: right click the icon to peek at the latest unread message in a small window, which marks it as read (vPilot messages first, then CPDLC). Right click again for the next one
- MSFS panel: right clicking when everything is read marks the latest received message as unread again
- MSFS panel: click the peek window to open the card on that message
- MSFS panel: CPDLC messages that need an answer show their reply buttons (WILCO, UNABLE, STANDBY...) right in the peek window
- MSFS panel: the peek window stays open while the mouse is over it, and closes 3 seconds after the mouse leaves

## 0.6.2

- The "Got it" button is replaced by a small tick next to the time: click it to mark a message as read (panel and phone)

## 0.6.1

- MSFS panel: text fields no longer take the keyboard away from MSFS, so controllers (yoke, joystick, throttle...) always keep working while you type. Keys bound to sim commands also reach the sim while typing
- MSFS panel: a text field gives up its cursor after 15 seconds without typing (and on Esc), so later sim key presses can't end up in a forgotten message box
- MSFS panel: the TYPING badge is removed (keys no longer go only to Clearway)

## 0.6.0

- MSFS panel: the card opens towards the middle of the screen vertically too (bottom-left icon: card opens up and to the right; bottom-right: up and to the left)
- MSFS panel: padlock button next to the notepad locks the direction the card opens
- MSFS panel: clock in the top bar - UTC by default; click to switch to sim time and local time (each in its own colour)
- Accented letters (é, à, ç, ü...) now display correctly in received messages: Clearway reads both UTF-8 and Western-European text from Hoppie and repairs the classic "Ã©" mix-up in vPilot messages. Messages to Hoppie are sent in the same Western-European encoding
- MSFS panel: a text field keeps the keyboard while its cursor blinks, even when the mouse moves away. It is released by a click elsewhere (the panel losing focus), Esc, collapsing the card or switching tabs. A TYPING badge shows while the keyboard goes to Clearway (click it to release). Controllers are not affected
- MSFS panel: the cursor stays in the message box after Send

## 0.5.0

- The Windows companion is now a normal program folder (Clearway.exe + _internal) instead of a single self-extracting exe, and carries proper file details (product, version, description). This avoids most antivirus false positives that the self-extracting format triggered
- Releases now include the all-in-one zip (MSFS panel + companion + vPilot plugin) built automatically

## 0.4.1

- MSFS panel: text fields (notepad, chat, requests) give the keyboard and mouse back to the sim as soon as the mouse leaves the card, on Esc, or when collapsing; previously the sim stayed blocked
- MSFS panel: the idle icon is fainter (12%) and grey; colour comes back on hover
- Nearby ATC: an arrow on each controller expands their information in place (no more double-click; nothing added to the frequency chat)
- Phone instructions now cover Android as well as iPhone (the phone app works on both)
- Phone: VDGS button in the vPilot tab opens the official VDGS page (vats.im/vdgs) for TOBT/TSAT and start-up times
- Fixed: the vPilot tab kept showing 'connected' after vPilot or its plugin had closed

## 0.4.0

- Commands and messages reach vPilot in about 30 ms instead of up to a second (Mode C, standby, ident, chat)
- MSFS panel: COM1/COM2 frequencies read from the sim; the transmit frequency shows on the FREQ tab, hover for both radios (also shown on the phone)
- Purpose labels on CPDLC messages: DCL, CLEARANCE, OCEANIC, LOGON, REQUEST, METAR/TAF/ATIS
- MSFS panel: Enter sends; message boxes grow with long text; hints clear themselves; text 2 px smaller; bigger collapse arrows
- MSFS panel: the floating icon fades when there is nothing to read
- MSFS panel: fixed symbols that showed as boxes in the sim's font (x, ..., arrows)
- Clearance form: 'Aircraft type' label, prefilled from vPilot
- Fixed: v0.3.0 panel card stretched across the screen and wasn't clickable

## 0.3.0

- New layout: **vPilot** tab (left) and **CPDLC** tab (right) on the phone, PC page and MSFS panel
- vPilot tab: frequency chat, private chat tabs, nearby controllers (double-click for info), connect/disconnect, Mode C/standby, ident and vPilot's dot commands
- Unread counters: cyan (#00d8d4) for vPilot on the left, amber for CPDLC on the right, on the tabs and the panel icon
- Notepad, shared between all screens and kept between sessions
- vPilot chat and CPDLC history are limited separately, so busy frequencies never push out CPDLC messages

## 0.2.0

- vPilot plugin: private messages, frequency text that mentions you, broadcasts and SELCAL alerts appear in Clearway, on the phone (with notifications) and in the MSFS panel
- Send private or frequency text messages through vPilot from the phone (Requests → Text message) or the panel (PM)
- Connects to Hoppie automatically when vPilot connects, using vPilot's callsign straight away

## 0.1.1

- MSFS panel: request pre-departure clearance, oceanic clearance and telex (the panel previously only had logon, level, direct, free text and weather)
- Delete single messages (× on each message) in the panel and on the phone; trash button in the panel to clear old messages
- Collapse any message to a single line (chevron), synced between phone and panel
- Restore deleted messages (kept until Clearway quits)

## 0.1.0

First version.

- Windows companion: Hoppie polling (45–75 s, 20 s while waiting for a reply), CPDLC logon, logoff and handover, replies, requests, PDC, oceanic, telex, METAR, TAF and ATIS, automatic ADS-C
- iPhone/desktop web app with pairing QR code
- ntfy phone notifications with quick-reply buttons, optionally muted while the MSFS panel is open
- Runs as a tray icon (no console window); doesn't open the browser on start except the first time
- Dark theme by default, light theme optional (phone, PC and panel)
- MSFS toolbar panel: draggable floating icon, flashes on new messages and stays amber until acknowledged
