# Design System: Stagegen Console

## 1. Visual Theme & Atmosphere
Stagegen is the operator console for live-show visuals, and it should feel like a piece of stage hardware rather than a web page: a Bauhaus-school instrument built like a Braun / Dieter Rams device. Picture a warm graphite chassis, cream enamel legend plates, machined round and square keys, recessed screens and long-throw faders. The Bauhaus side brings a strict modular grid, the elementary shapes (circle, square, triangle) and the three primaries. The skeuomorphic side brings physical depth, with a single light source from above.

- **Density:** Cockpit Dense (7/10). Operators work quickly in dark venues, and everything they need for the show is visible on one screen without scrolling.
- **Variance:** Offset Asymmetric (5/10). The 12-column grid is strict, but the modules are different sizes: a big preview screen, a narrow cue sheet, full-width strips.
- **Motion:** Static Restrained (3/10). Things move the way hardware does: keys depress, LEDs light, meters bounce. There are no decorative animations.
- **Light comes from the sky.** Every raised surface is lighter on top with a 1px top highlight, and casts a shadow below. Every recessed surface (screens, wells, input slots) has an inner shadow at the top edge and a faint highlight on the bottom lip.
- **Grayscale first.** Spacing, size and depth create the hierarchy. The three primaries are reserved for function and are never used as decoration.

## 2. Color Palette & Roles
Neutrals (one warm-neutral family only):
- **Graphite Chassis** (#1E1D1B): app background, the powder-coated body of the console
- **Raised Panel** (#2A2926): module faces. Top-light gradient from #302F2B to #262522.
- **Deep Well** (#121210): recessed screens, waveform well, input slots
- **Machined Edge** (#3A3833): 1px seams between modules, key borders
- **Enamel Cream** (#ECE6D6): primary text, legend plates, cue-sheet paper
- **Silkscreen Dim** (#9C9688): secondary labels, units, metadata (un-popped text)
- **Shadow Ink** (#0D0D0C): drop shadows under raised parts

Bauhaus primaries (functional coding only, desaturated so they read as painted enamel, not neon):
- **Bauhaus Blue** (#2C5AA0): transport and AI, meaning Play, Refine, and primary actions
- **Bauhaus Yellow** (#E0A52E): cueing and attention, meaning the selected or next section, Next key, warnings
- **Bauhaus Red** (#C23B2E): on-air and danger, meaning LIVE mode, Blackout, playhead, delete, faults

Each primary has one role. A screen should show at most one large primary-colored key per role.

## 3. Typography Rules
- **Display and legends:** `Jost` (geometric, Futura lineage, the Bauhaus type tradition). Module headers are uppercase at 11px with 0.14em tracking, silkscreened in Silkscreen Dim. Titles use Jost 500 at 18 to 22px in Enamel Cream, with tight tracking.
- **Body:** `Jost` 400 at 14px, line-height 1.5, max 65ch. Body text appears only in the cue sheet and prompt.
- **Mono:** `JetBrains Mono` for every number: timecode, BPM, ms, dB, percentages, positions. Because density is above 7, all numerals are mono.
- **Make text pop, and un-pop:** important values are Enamel Cream and larger. Labels and units are Silkscreen Dim and smaller. Bold is never used for labels.
- **Banned:** Inter, system-ui defaults, and any serif.

## 4. Component Stylings
- **Modules:** Raised Panel faces with 4px corner radius, so they read as machined metal. Each has a numbered silkscreen header strip, for example "01 · PREVIEW" and "02 · TRANSPORT". Tiny 6px screw heads sit in the module corners. Modules are separated by 12px Graphite gaps, never by borders alone.
- **Round keys (transport):** circles of 44 to 56px. Play is a Bauhaus Blue cap with a cream triangle glyph, and Stop is a graphite cap with a cream square glyph. The raised state has a top highlight and a 2px bottom shadow. When pressed, the key translates down 1px, the inner shadow moves to the top, and the bottom shadow disappears.
- **Square pads (sections):** backlit 72 to 88px squares with 6px radius. Each has a 6px stripe at the bottom in the section's palette color, a number legend top-left and the title below. The cued pad lights from inside with a Bauhaus Yellow inner fill at 18% plus a yellow rim. The on-air pad in Live mode gets a red rim and a red LED dot. Illumination is always inside the pad, never an outer glow.
- **Faders:** long-throw vertical faders with a grooved Deep Well track and a ribbed cream cap. A Jost scale is silkscreened beside the track, and the mono value sits below.
- **Knobs:** 40px knurled graphite knobs with a cream pointer line and a printed arc scale. They are used for offset ms and BPM fine trim.
- **Rocker / latching switches:** mode selection (TRACK | LIVE) is a two-position rocker. The active side is pressed in and shows its LED: blue for Track, red for Live.
- **LED ladders:** segmented level meters with 12 segments: cream segments, then yellow at 75%, then red at 92%.
- **Status lamps:** 8px round LEDs with a cream legend beside them (SERVER, AI, OUTPUTS). Blue means OK, yellow means degraded, red means fault, and unlit graphite means off.
- **Screens:** the preview and timecode sit in a Deep Well bezel with a 10px inset, an inner top shadow and a faint glass reflection (a 4% white diagonal) across the top third.
- **Cue sheet:** the right-hand plan panel is a Raised Panel holding an Enamel Cream paper card with Graphite text, like a printed run sheet. Section entries are separated by hairline rules, not nested cards.
- **Inputs:** recessed Deep Well slots with an inner top shadow and the label above in a silkscreen style. On focus, a 1px Bauhaus Blue rim appears.
- **Prompt module:** a full-width "teleprinter" strip with a cream paper input slot and a large Bauhaus Blue REFINE key on the right.
- **Empty states:** a composed Bauhaus figure (circle, square and triangle in outline) plus one instruction line. No illustrations of people.
- **Loading:** a skeletal shimmer inside the Deep Well, matching the shape of what is loading. No spinners.

## 5. Layout Principles
- 12-column grid, 1440px max width, 12px gutters and 16px outer margins. Modules snap to the grid and never overlap.
- **Studio:** top rail with logotype, project cartridge label, status lamps, SHOW OUTPUT key and settings. Below it:
  - Columns 1–8: preview screen (16:9).
  - Columns 9–12: cue sheet.
  - Full width: transport/live strip, then section pads, then timeline well, then prompt module.
- **Live performance view:** the preview shrinks, pads grow to 120px, and a big yellow NEXT key, a red BLACKOUT key and an intensity fader occupy the right hand side.
- Generous padding inside modules (16 to 20px). Density comes from the number of modules, not from cramping.
- Touch targets are at least 44px, because operators may use a touchscreen at front of house.

## 6. Motion & Interaction
- Keys depress in 80ms with a physical ease-out and spring back.
- Meters use a fast attack (30ms) and a slow release (300ms), like a real VU meter.
- The playhead moves linearly with time. Nothing else moves continuously.
- Only `transform` and `opacity` are animated.

## 7. Anti-Patterns (Banned)
- No purple, no neon, no outer glows, no gradient text.
- No pure black (#000000) and no pure white.
- No emojis, and no Inter.
- No 3-equal-card rows, and no nested cards.
- No glassmorphism blur panels. Glass appears only as the faint reflection on screens.
- No light coming from below. Inverted shadows are never used.
- No decorative use of the primaries: color always means a function.
- No AI clichés in copy ("Elevate", "Seamless", "Unleash"). Labels are short, hardware-style verbs and nouns: PLAY, CUE, NEXT, BLACKOUT, REFINE.
- No placeholder names. Sample content is the show "Dust & Neon", with sections "Long Shadows", "First Light", "Sandstorm", "Neon Storm", "Afterglow" at 119.8 BPM in A minor.
