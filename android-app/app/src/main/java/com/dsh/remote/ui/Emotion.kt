package com.dsh.remote.ui

import com.dsh.remote.data.ConnectionState
import com.dsh.remote.data.Message
import com.dsh.remote.ui.character.Expression

/**
 * Maps app state onto the character's expression.
 *
 * The reference project swaps 立绘 on emotion; here the "emotion" is whatever
 * the remote session is doing, which is what makes the illustration useful
 * rather than decorative: it tells you at a glance whether the agent is working,
 * waiting for an approval, or the link is down.
 */
fun emotionFor(state: UiState): Expression {
    val openSession = state.detail?.let { detail -> state.sessions.firstOrNull { it.id == detail.id } }
    val lastAssistant = state.detail?.messages?.lastOrNull { it.role == Message.Role.Assistant }
    val justReplied = lastAssistant != null && System.currentTimeMillis() - lastAssistant.time < 8_000

    return when {
        state.connection == ConnectionState.Unpaired -> Expression.Nervous
        state.connection != ConnectionState.Online -> Expression.Nervous
        state.interactions.isNotEmpty() -> Expression.Surprised
        state.sendFailed -> Expression.Angry
        state.detail == null && state.busy -> Expression.Thinking
        openSession?.running == true -> Expression.Thinking
        justReplied -> Expression.Happy
        else -> Expression.Calm
    }
}
