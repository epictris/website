# The input latch

**Every button edge the DOM delivers reaches the sim as at least one frame** (`input/latch.ts`).
The live input sources used to keep a plain boolean per button, set on the down event and cleared on the up, read once per sim step.
A click shorter than a step, both events landing between two samples, never changed what any sample saw: the press was gone without a trace, and the mirror case read a release-and-re-press inside one step as an unbroken hold.
`ButtonLatch` keeps the transitions the sampler has not reported yet and plays them out one per sample, so a sub-step click is one held frame then a released one, and a sub-step re-click a released frame then a held one.
A level that matches the last one queued (a key's auto-repeat, an up without a down because the down landed off the canvas) queues nothing.
Every latch is sampled once per step whatever its neighbours said - no short-circuit, or a latch behind a held one keeps its queued edge for a later frame.
An edge is queued only while the source is the one driving the game (`active`); the editor's sources outlive a test, and a click on the canvas between tests is a selection, not a shot to be played into the next test's first frames.
Each mousemove also reconciles the mouse latches with its `buttons` bitmask, so a press or release the browser knew about and never announced as an event is picked up at the next move rather than never.
`cli latch` is the case suite.

**The clicks that prompted it were not lost in the page.**
`session-929f` was a release at f852 and no press for the 77 frames after, on a hand whose recorded holds run as short as three frames, and the bundle could say nothing about why, because a bundle's frames are what the sim sampled.
A temporary trace of the raw DOM input beside the frames answered it: bundles recorded while a headless chromium grab ran on the same machine carried `mouseup` events with no `mousedown` before them and a `buttons` bitmask that never showed the button down, with the page focused and pointer-locked throughout and every lost press inside the life of that grab's chromium.
The presses were lost between the Wayland compositor and the browser process.
The desktop browser and a headless grab are the same `chromium-browser` binary, and a second instance attached to the session while the first held a pointer lock is what cost it its presses; the same launch loop with the grab detached from the display reproduced nothing.
So `shotRunner` launches chromium with `--ozone-platform=headless` and `WAYLAND_DISPLAY`/`DISPLAY` unset - a grab needs no display, ANGLE over EGL finds the GPU without one - and any other headless chromium run on this machine wants the same.
The latch stays whatever the browser does, since a click shorter than a step is a real hole.

**The drops outlived that explanation, so the trace is permanent** (`input/inputTrace.ts`, the `inputTrace` field of a P bundle from the game and from an editor test alike, read by `cli clicks`).
`session-2191f` (2026-09-08 01:35) was an editor test bundle with a dropped click near its end and no trace to place it with, because only the game's export carried one; a bundle `cli clicks` refuses for lacking a trace was made by a page from before the export it came through had one.
`session-1346f` and `session-796f` (2026-09-07, 23:05 and 23:10) each end in seconds of aiming with no press, with no second chromium on the machine and nothing in the compositor's log for the hour.
The trace had been removed by then, so once again the bundles could only say what the sim sampled.
It now records every mousedown and mouseup the window sees (capture phase, target named when it is not the canvas), every mousemove whose `buttons` bitmask changed, the pointer lock coming and going, focus, visibility, and the cursor entering and leaving the canvas, each stamped with the run and sim frame it landed after.
A bundle also carries the controller's button map (`InputTraceBundle.bits`, from `BUTTON_BITS`): the grapple controller binds left to `fire` and right to `retractClick`, the ball controller drives `fire` from every button, and without the map a right-click deploy in a ball bundle reads as a press that reached no frame.
`cli clicks` lays it against the frames and names the layer that lost a click: an **orphan up** (a release with no press before it) is a press the browser never had, so the compositor, libinput or the mouse lost it; an **unsampled** down is one the DOM delivered and the page dropped; an **unsourced** held run is a press the sim saw with nothing in the DOM behind it (pad or touch).
The desktop is sway on wlroots, the mouse a Razer DeathAdder V2 on `event9`; `journalctl` shows libinput's button-debounce timer on that device firing late under compositor lag earlier the same day, which is the layer to watch when the next orphan up arrives.
The evdev half of that comparison is `libinput debug-events` beside the session, read by `cli clicks bundle.json --evdev /tmp/evdev.log`: it aligns the two clocks by the presses both streams share, lists the presses either side lacks, and prints both streams over the seconds before each orphan up with a verdict (the mouse sent it and the browser never got it; the mouse never sent it; or the log ends before it).
Capture it line-buffered, or a stopped pipe drops everything past the last 4 KiB flush - `session-5375f` (2026-09-08 01:40) had its orphan up at 92 s and a log that ended at 83 s for exactly that reason, with 139 of the 153 presses it did cover matching to the millisecond:

```sh
sudo stdbuf -oL libinput debug-events --device /dev/input/event9 | grep --line-buffered POINTER_BUTTON > /tmp/evdev.log
```

`session-1192f` (2026-09-08 01:46) and `session-2004f` (01:53) had both halves and answered the first question: **the press is not lost, it is flipped.**
Over 33 clicks the mouse's press and the DOM's mousedown sit 13 ms apart to the millisecond; at 23.420 s the mouse pressed and the browser received a *release*, and the mouse's release 216 ms later reached nothing.
It began with the virtual cursor, which is to say with pointer lock; `?aim=position` plays without the lock and is the control.
So the mouse and the kernel are cleared (`libinput debug-events` is its own libinput context reading the same evdev node, so it also clears the raw stream of anything a debounce could misread), and the flip is in sway's libinput, sway/wlroots, or Chromium's Wayland input.
The layer between those is the Wayland protocol itself, which `WAYLAND_DEBUG=1` on the browser prints one event per line; `cli clicks --wayland /tmp/wayland.log` reads it as a third stream, so a press that is a press on the wire and a release in the DOM is Chromium's, and one that is a release on the wire is the compositor's:

```sh
WAYLAND_DEBUG=1 chromium-browser --user-data-dir=/tmp/wl-profile --ozone-platform=wayland http://localhost:3100/ 2>&1 | grep --line-buffered "wl_pointer.*button" > /tmp/wayland.log
```

**Answered: it is Chromium** (`session-296f`, 2026-09-08 01:59, all three streams).
The wire carried a proper press and release for the click the page saw as a lone release, so sway and libinput are cleared too, and `?aim=position` (no lock) never dropped one.
The mechanism, from Chromium 142's source: under pointer lock, Chromium's Wayland event source feeds every relative-motion delta into an unbounded `relative_pointer_location_` (`WaylandEventSource::OnRelativePointerMotion`), so its idea of where the pointer is drifts out of the page with the hand's net travel while the game's own cursor stays clamped.
Every press is hit-tested by the browser frame at that drifted point (`WindowEventFilterLinux::HandleLocatedEventWithHitTest`); one that lands on the caption or a resize border becomes an `xdg_toplevel.move`/`resize` request, which sway ignores for a tiled window, and `WaylandToplevelWindow::DispatchHostWindowDragMovement` then synthesizes a release for every pressed button (`ReleasePressedPointerButtons`, its TODO is crbug.com/40917147).
The renderer gets the synthesized release only (the press was consumed by the frame), and the real release is ignored as a release of an unpressed button (`OnPointerButtonEvent`).
Nothing in the page can see or recover a press the frame ate.
Workarounds: play fullscreen (no caption, no borders to hit), or run chromium with `--ozone-platform=x11`.
The first of those is now the default: the lock is taken **only in fullscreen** (see the aim modes above), so a windowed session never enters the state that loses presses.
