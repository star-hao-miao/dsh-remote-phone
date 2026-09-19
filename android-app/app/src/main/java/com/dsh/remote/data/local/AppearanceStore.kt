package com.dsh.remote.data.local

import android.content.Context

/** Light / dark / follow-the-system, mirroring the reference UI's toggle. */
enum class ThemeMode { System, Light, Dark }

/** Reads `"light"` / `"dark"` / anything else (system). */
fun themeModeOf(raw: String?): ThemeMode = when (raw) {
    "light" -> ThemeMode.Light
    "dark" -> ThemeMode.Dark
    else -> ThemeMode.System
}

fun ThemeMode.storageValue(): String = when (this) {
    ThemeMode.Light -> "light"
    ThemeMode.Dark -> "dark"
    ThemeMode.System -> "system"
}

/**
 * Appearance preferences (the reference project exposes exactly these knobs:
 * theme, font scale and character opacity).
 */
data class Appearance(
    val themeMode: ThemeMode = ThemeMode.System,
    /** 0.9 = small, 1.0 = default, 1.12 = large (same steps as the reference). */
    val fontScale: Float = 1f,
    /** How strongly the character illustration shows through. */
    val characterOpacity: Float = 1f,
    /** Lets the character layer be hidden entirely (small screens, battery). */
    val characterVisible: Boolean = true,
)

class AppearanceStore(context: Context) {

    private val prefs = context.getSharedPreferences("dsh_remote_appearance", Context.MODE_PRIVATE)

    fun load(): Appearance = Appearance(
        themeMode = themeModeOf(prefs.getString(KEY_THEME, null)),
        fontScale = prefs.getFloat(KEY_FONT_SCALE, 1f).coerceIn(0.8f, 1.3f),
        characterOpacity = prefs.getFloat(KEY_CHAR_OPACITY, 1f).coerceIn(0f, 1f),
        characterVisible = prefs.getBoolean(KEY_CHAR_VISIBLE, true),
    )

    fun save(appearance: Appearance) {
        prefs.edit()
            .putString(KEY_THEME, appearance.themeMode.storageValue())
            .putFloat(KEY_FONT_SCALE, appearance.fontScale)
            .putFloat(KEY_CHAR_OPACITY, appearance.characterOpacity)
            .putBoolean(KEY_CHAR_VISIBLE, appearance.characterVisible)
            .apply()
    }

    private companion object {
        const val KEY_THEME = "theme_mode"
        const val KEY_FONT_SCALE = "font_scale"
        const val KEY_CHAR_OPACITY = "character_opacity"
        const val KEY_CHAR_VISIBLE = "character_visible"
    }
}
