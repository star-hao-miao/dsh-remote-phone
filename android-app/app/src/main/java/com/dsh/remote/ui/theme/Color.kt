package com.dsh.remote.ui.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * Palette ported from the reference design we are mimicking
 * (`thecookfish1201-svg/DeepSeek-whale-Chat`, MIT): a minimal glassmorphism
 * look with a day/night pair of themes.
 *
 * The CSS variables map 1:1 so the two stay recognisably the same design:
 *
 * | reference variable | here |
 * |---|---|
 * | `--bg` | [Bg] / [BgDark] |
 * | `--text`, `--muted` | [Ink] / [InkDark], [Muted] / [MutedDark] |
 * | `--card`, `--card-strong` | [Card] / [CardDark], [CardStrong] / [CardStrongDark] |
 * | `--bubble-user`, `--bubble-assistant` | [BubbleUser] / [BubbleAssistant] (+ dark) |
 * | `--border` | [Border] / [BorderDark] |
 * | `--accent`, `--accent-2` | [Accent] / [Accent2] (+ dark variants) |
 * | `--danger` | [Danger] |
 */

// ── light ──────────────────────────────────────────────────────────────────
val Bg = Color(0xFFF5F7FA)
val Ink = Color(0xFF1A1A2E)
val Muted = Color(0xFF6B7280)
val Card = Color(0xB3FFFFFF)             // rgba(255,255,255,.7)
val CardStrong = Color(0xD9FFFFFF)       // rgba(255,255,255,.85)
val BubbleUser = Color(0xE6FFFFFF)       // rgba(255,255,255,.9)
val BubbleAssistant = Color(0xA6FFFFFF)  // rgba(255,255,255,.65)
val Border = Color(0x14000000)           // rgba(0,0,0,.08)
val InputBg = Color(0xBFFFFFFF)          // rgba(255,255,255,.75)
val DrawerBg = Color(0xC7FFFFFF)         // rgba(255,255,255,.78)
val Accent = Color(0xFF3B82F6)
val Accent2 = Color(0xFF6366F1)

// ── dark ───────────────────────────────────────────────────────────────────
val BgDark = Color(0xFF0D1117)
val InkDark = Color(0xFFE6EDF3)
val MutedDark = Color(0xFF8B949E)
val CardDark = Color(0xB3000000)          // rgba(0,0,0,.7)
val CardStrongDark = Color(0xD1000000)    // rgba(0,0,0,.82)
val BubbleUserDark = Color(0xE61E293B)    // rgba(30,41,59,.9)
val BubbleAssistantDark = Color(0xA61E293B)
val BorderDark = Color(0x1AFFFFFF)        // rgba(255,255,255,.1)
val InputBgDark = Color(0xB30D1117)       // rgba(13,17,23,.7)
val DrawerBgDark = Color(0xD10D1117)      // rgba(13,17,23,.82)
val AccentDark = Color(0xFF60A5FA)
val Accent2Dark = Color(0xFF818CF8)

// ── shared ─────────────────────────────────────────────────────────────────
val Danger = Color(0xFFEF4444)
val DangerSoft = Color(0x1FEF4444)       // rgba(239,68,68,.12)
val EmotionPink = Color(0xFFEC4899)
val Success = Color(0xFF10B981)
val Busy = Color(0xFFF59E0B)

/** `linear-gradient(135deg, accent, accent-2)` from the reference. */
fun accentGradient(accent: Color, accent2: Color): Brush =
    Brush.linearGradient(listOf(accent, accent2))

/**
 * The page backdrop. The reference sits on a flat `--bg` and relies on the
 * character illustration for depth; on a phone we add a very soft radial wash so
 * the translucent cards still read as glass without a real backdrop blur.
 */
fun backdropBrush(dark: Boolean): Brush = if (dark) {
    Brush.radialGradient(colors = listOf(Color(0xFF16233A), BgDark), radius = 1400f)
} else {
    Brush.radialGradient(colors = listOf(Color(0xFFE8EEFB), Bg), radius = 1400f)
}
