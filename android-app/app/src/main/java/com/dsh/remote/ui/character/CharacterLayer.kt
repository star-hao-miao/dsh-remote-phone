package com.dsh.remote.ui.character

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import com.dsh.remote.R
import kotlinx.coroutines.launch

/**
 * Expressions shipped by the reference project (one PNG each). The mood is
 * driven by what the app is doing - see [com.dsh.remote.ui.Emotion].
 */
enum class Expression(val resId: Int, val label: String) {
    Calm(R.drawable.char_calm, "待机"),
    Happy(R.drawable.char_happy, "开心"),
    Thinking(R.drawable.char_thinking, "思考中"),
    Sad(R.drawable.char_sad, "难过"),
    Nervous(R.drawable.char_nervous, "未连接"),
    Surprised(R.drawable.char_surprised, "待处理"),
    Angry(R.drawable.char_angry, "发送失败"),
    Silly(R.drawable.char_silly, "发呆"),
    Eating(R.drawable.char_eating, "忙碌"),
    Hit(R.drawable.char_hit, "被戳"),
}

/**
 * The character illustration layer.
 *
 * Mirrors the reference behaviour: cross-fade between expressions, a poke
 * reaction (shake), and red rings while "angry" (a failed send). On a phone the
 * layer sits above the chat card (the reference's own mobile layout).
 */
@Composable
fun CharacterLayer(
    expression: Expression,
    opacity: Float,
    modifier: Modifier = Modifier,
    showAngryRings: Boolean = false,
) {
    val scope = rememberCoroutineScope()
    val shake = remember { Animatable(0f) }
    var poked by remember { mutableStateOf(false) }

    Box(
        modifier = modifier
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = {
                        poked = true
                        scope.launch {
                            // charShake keyframes from the reference stylesheet.
                            listOf(0f, -1f, 0.8f, -0.5f, 0f).forEach { step ->
                                shake.animateTo(step, tween(90))
                            }
                        }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        if (showAngryRings) AngryRings()

        Crossfade(targetState = expression, animationSpec = tween(300), label = "expression") { current ->
            Image(
                painter = painterResource(current.resId),
                // The description states the mood, which makes the layer
                // verifiable from a UI dump and useful to screen readers.
                contentDescription = "立绘 · ${current.label}",
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .alpha(opacity)
                    .graphicsLayer { translationX = shake.value * 18f },
            )
        }
    }
}

/** `ringPulse`: three expanding rings, as in the reference's angry state. */
@Composable
private fun AngryRings() {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        while (true) {
            progress.snapTo(0f)
            progress.animateTo(1f, tween(1500))
        }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .fillMaxWidth(0.6f)
                .drawBehind {
                    val scale = 0.5f + progress.value
                    val radius = size.minDimension / 2f * scale
                    drawCircle(
                        color = Color(0xBFEF4444),
                        radius = radius,
                        alpha = (1f - progress.value).coerceIn(0f, 1f) * 0.9f,
                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4f),
                    )
                },
        )
    }
}
