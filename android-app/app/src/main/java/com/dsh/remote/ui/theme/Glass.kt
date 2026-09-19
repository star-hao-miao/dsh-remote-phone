package com.dsh.remote.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The reference look is `backdrop-filter: blur(20px)` on translucent cards.
 * Compose cannot blur what is *behind* a composable (Modifier.blur blurs its own
 * content), so glass is approximated with the reference's own translucency
 * values, a hairline border and the same soft shadow - which is what actually
 * reads as "glass" on a flat backdrop.
 */
fun Modifier.glass(
    color: Color,
    borderColor: Color,
    shape: Shape,
    elevation: Dp = 20.dp,
    borderWidth: Dp = 1.dp,
): Modifier = this
    .shadow(elevation, shape, clip = false, ambientColor = Color.Black.copy(alpha = 0.18f), spotColor = Color.Black.copy(alpha = 0.22f))
    .clip(shape)
    .background(color)
    .border(borderWidth, borderColor, shape)

@Composable
fun Modifier.glassCard(radius: Dp = 24.dp, strong: Boolean = false): Modifier {
    val palette = LocalGlassPalette.current
    return glass(
        color = if (strong) palette.cardStrong else palette.card,
        borderColor = palette.border,
        shape = RoundedCornerShape(radius),
    )
}

@Composable
fun Modifier.glassPanel(radius: Dp = 16.dp): Modifier {
    val palette = LocalGlassPalette.current
    return glass(
        color = palette.card,
        borderColor = palette.border,
        shape = RoundedCornerShape(radius),
        elevation = 8.dp,
    )
}

/** Corner radii taken from the reference stylesheet. */
object Radii {
    val Card = 24.dp
    val Drawer = 0.dp
    val Bubble = 16.dp
    val BubbleTail = 6.dp
    val Button = 14.dp
    val IconButton = 12.dp
    val Field = 14.dp
    val Chip = 999.dp
    val Panel = 16.dp
}
