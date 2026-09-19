package com.dsh.remote.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import com.dsh.remote.data.local.ThemeMode

private val LightScheme = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    primaryContainer = CardStrong,
    onPrimaryContainer = Ink,
    secondary = Accent2,
    onSecondary = Color.White,
    background = Bg,
    onBackground = Ink,
    surface = CardStrong,
    onSurface = Ink,
    surfaceVariant = Card,
    onSurfaceVariant = Muted,
    outline = Border,
    error = Danger,
    onError = Color.White,
)

private val DarkScheme = darkColorScheme(
    primary = AccentDark,
    onPrimary = Color(0xFF0B1220),
    primaryContainer = CardStrongDark,
    onPrimaryContainer = InkDark,
    secondary = Accent2Dark,
    onSecondary = Color(0xFF0B1220),
    background = BgDark,
    onBackground = InkDark,
    surface = CardStrongDark,
    onSurface = InkDark,
    surfaceVariant = CardDark,
    onSurfaceVariant = MutedDark,
    outline = BorderDark,
    error = Danger,
    onError = Color.White,
)

/**
 * The reference UI's font stack is the platform UI font; Compose's default
 * ([FontFamily.Default]) resolves to Roboto, which is the same idea on Android.
 */
private val BaseTypography = Typography(
    titleLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Bold, fontSize = 17.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 23.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 14.sp),
)

/** Resolved glass colours for the current theme (see [Color.kt]). */
data class GlassPalette(
    val dark: Boolean,
    val card: Color,
    val cardStrong: Color,
    val border: Color,
    val inputBg: Color,
    val drawerBg: Color,
    val bubbleUser: Color,
    val bubbleAssistant: Color,
    val accent: Color,
    val accent2: Color,
    val text: Color,
    val muted: Color,
)

val LocalGlassPalette = staticCompositionLocalOf {
    GlassPalette(
        dark = false,
        card = Card,
        cardStrong = CardStrong,
        border = Border,
        inputBg = InputBg,
        drawerBg = DrawerBg,
        bubbleUser = BubbleUser,
        bubbleAssistant = BubbleAssistant,
        accent = Accent,
        accent2 = Accent2,
        text = Ink,
        muted = Muted,
    )
}

fun glassPalette(dark: Boolean): GlassPalette = if (dark) {
    GlassPalette(
        dark = true,
        card = CardDark,
        cardStrong = CardStrongDark,
        border = BorderDark,
        inputBg = InputBgDark,
        drawerBg = DrawerBgDark,
        bubbleUser = BubbleUserDark,
        bubbleAssistant = BubbleAssistantDark,
        accent = AccentDark,
        accent2 = Accent2Dark,
        text = InkDark,
        muted = MutedDark,
    )
} else {
    GlassPalette(
        dark = false,
        card = Card,
        cardStrong = CardStrong,
        border = Border,
        inputBg = InputBg,
        drawerBg = DrawerBg,
        bubbleUser = BubbleUser,
        bubbleAssistant = BubbleAssistant,
        accent = Accent,
        accent2 = Accent2,
        text = Ink,
        muted = Muted,
    )
}

/**
 * App theme: reference palette + the reference's `--font-scale` knob, applied
 * through the density font scale so every text style scales together.
 */
@Composable
fun DshRemoteTheme(
    themeMode: ThemeMode = ThemeMode.System,
    fontScale: Float = 1f,
    content: @Composable () -> Unit,
) {
    val dark = when (themeMode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalGlassPalette provides glassPalette(dark),
        LocalDensity provides Density(density.density, fontScale.coerceIn(0.8f, 1.3f)),
    ) {
        MaterialTheme(
            colorScheme = if (dark) DarkScheme else LightScheme,
            typography = BaseTypography,
            content = content,
        )
    }
}
