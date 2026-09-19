package com.dsh.remote.ui.pair

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.dsh.remote.R
import com.dsh.remote.ui.theme.LocalGlassPalette
import com.dsh.remote.ui.theme.Radii
import com.dsh.remote.ui.theme.accentGradient
import com.dsh.remote.ui.theme.glassCard

/**
 * First-run pairing gate, dressed in the reference's glass style: character
 * illustration + a translucent card.
 *
 * Two entry points, one contract: the QR (or the pasted link) carries
 * `<gateway-base>/pair?code=XXXX`; the ViewModel exchanges the code for a JWT
 * via `POST /api/pair/verify`.
 */
@Composable
fun PairingScreen(
    error: String?,
    busy: Boolean,
    onPairLink: (String) -> Unit,
) {
    var link by remember { mutableStateOf("") }
    val palette = LocalGlassPalette.current
    val context = LocalContext.current
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result?.contents
        if (!contents.isNullOrBlank()) onPairLink(contents)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // The character says "not connected yet" before a single word is read.
        Box(
            modifier = Modifier
                .fillMaxWidth(0.62f)
                .height(200.dp),
            contentAlignment = Alignment.Center,
        ) {
            androidx.compose.foundation.Image(
                painter = painterResource(R.drawable.char_nervous),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        }

        Spacer(Modifier.height(10.dp))
        Text("DSH Remote", style = MaterialTheme.typography.titleLarge, color = palette.text)
        Spacer(Modifier.height(6.dp))
        Text(
            text = "连接电脑上的 DeepSeek Harness，在手机上查看会话、历史与审批",
            style = MaterialTheme.typography.bodySmall,
            color = palette.muted,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(22.dp))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .glassCard(Radii.Card, strong = true)
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = Icons.Filled.QrCodeScanner,
                contentDescription = null,
                tint = palette.accent,
                modifier = Modifier.size(40.dp),
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = "在电脑的 DSH 面板（鲸鱼按钮）生成配对码，然后扫码",
                style = MaterialTheme.typography.bodySmall,
                color = palette.muted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = {
                    val options = ScanOptions().apply {
                        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        setPrompt("扫描电脑上的配对二维码")
                        setBeepEnabled(false)
                        setOrientationLocked(false)
                    }
                    scanner.launch(options)
                },
                enabled = !busy,
                shape = RoundedCornerShape(Radii.Button),
                colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("扫码配对") }

            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = link,
                onValueChange = { link = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("或粘贴配对链接") },
                placeholder = { Text("https://xxx.trycloudflare.com/pair?code=AB3DE7FQ") },
                singleLine = true,
                enabled = !busy,
                shape = RoundedCornerShape(Radii.Field),
            )
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = { onPairLink(link) },
                enabled = !busy && link.isNotBlank(),
                shape = RoundedCornerShape(Radii.Button),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("使用该链接配对") }

            if (busy) {
                Spacer(Modifier.height(16.dp))
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp, color = palette.accent)
            }
            if (error != null) {
                Spacer(Modifier.height(14.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(com.dsh.remote.ui.theme.DangerSoft)
                        .border(1.dp, com.dsh.remote.ui.theme.Danger.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
                        .padding(10.dp),
                ) {
                    Text(
                        text = error,
                        color = com.dsh.remote.ui.theme.Danger,
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text(
            text = "配对成功后，会话、历史与实时状态都来自电脑上的网关；断网时会提示离线。",
            style = MaterialTheme.typography.labelSmall,
            color = palette.muted,
            textAlign = TextAlign.Center,
        )
    }
}

/** `https://host:3080/pair?code=XXXX` → `https://host:3080`. */
internal fun extractBase(link: String): String {
    val trimmed = link.trim()
    if (trimmed.isEmpty()) return ""
    val beforePath = trimmed.substringBefore("/pair")
    return beforePair(if (beforePath.isEmpty()) trimmed.substringBefore("?") else beforePath)
}

private fun beforePair(value: String): String = value.trim().trimEnd('/')

/** `...?code=XXXX`, `AB3D-EFGH` or `ab3defgh` → `AB3DEFGH`. */
internal fun extractCode(link: String): String {
    val trimmed = link.trim()
    if (trimmed.isEmpty()) return ""
    val raw = if (trimmed.contains("code=")) trimmed.substringAfter("code=").substringBefore("&") else trimmed
    return raw.replace("-", "").replace(" ", "").uppercase()
}
