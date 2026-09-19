package com.dsh.remote.data.local

import android.content.Context
import com.dsh.remote.data.GatewayCredentials

/**
 * Persists the gateway endpoint + JWT between launches.
 *
 * SharedPreferences is enough for the structural milestone; a later milestone
 * moves both the token and the recent-cache encryption to a keystore-backed
 * store (see FRAMEWORK.md, M4).
 */
class CredentialStore(context: Context) {

    private val prefs = context.getSharedPreferences("dsh_remote_gateway", Context.MODE_PRIVATE)

    fun load(): GatewayCredentials? {
        val baseUrl = prefs.getString(KEY_BASE, null) ?: return null
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        val name = prefs.getString(KEY_DEVICE, null) ?: "phone"
        val expiresAt = prefs.getLong(KEY_EXPIRES, 0L)
        if (expiresAt in 1 until System.currentTimeMillis()) {
            clear()
            return null
        }
        return GatewayCredentials(baseUrl, token, name, expiresAt)
    }

    fun save(credentials: GatewayCredentials) {
        prefs.edit()
            .putString(KEY_BASE, credentials.baseUrl)
            .putString(KEY_TOKEN, credentials.token)
            .putString(KEY_DEVICE, credentials.deviceName)
            .putLong(KEY_EXPIRES, credentials.expiresAt)
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_BASE = "base_url"
        const val KEY_TOKEN = "token"
        const val KEY_DEVICE = "device_name"
        const val KEY_EXPIRES = "expires_at"
    }
}
