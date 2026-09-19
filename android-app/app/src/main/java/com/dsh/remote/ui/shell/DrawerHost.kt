package com.dsh.remote.ui.shell

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Overlay with a slide-in drawer and a dimmed scrim, following the reference's
 * `.drawer` / `.drawer-mask`: 250ms slide, 340dp (capped to 92vw there, 320dp
 * here), and the page behind dimmed so the glass panel reads as blur.
 */
@Composable
fun DrawerHost(
    open: Boolean,
    side: DrawerSide,
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = open,
            enter = fadeIn(tween(200)),
            exit = fadeOut(tween(200)),
            modifier = Modifier.fillMaxSize(),
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.35f))
                    .clickable(
                        // A scrim, not a button: no ripple, no semantics.
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onDismiss,
                    ),
            )
        }

        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = if (side == DrawerSide.Left) Alignment.CenterStart else Alignment.CenterEnd,
        ) {
            AnimatedVisibility(
                visible = open,
                enter = slideInHorizontally(tween(250)) { full -> if (side == DrawerSide.Left) -full else full },
                exit = slideOutHorizontally(tween(250)) { full -> if (side == DrawerSide.Left) -full else full },
            ) {
                Box(
                    Modifier
                        .fillMaxHeight()
                        .width(320.dp),
                ) {
                    content()
                }
            }
        }
    }
}

enum class DrawerSide { Left, Right }
