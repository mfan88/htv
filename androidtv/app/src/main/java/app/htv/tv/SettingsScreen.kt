package app.htv.tv

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text

@Composable
fun SettingsScreen(settings: Settings, onSaved: () -> Unit, onBack: (() -> Unit)?) {
    var url by remember { mutableStateOf(settings.savedUrl) }
    var token by remember { mutableStateOf(settings.savedToken) }
    // First run starts in the address field; otherwise on Cancel, so the keyboard
    // doesn't pop up the moment Settings opens.
    val initial = remember { FocusRequester() }
    if (onBack != null) BackHandler(onBack = onBack)

    Column(Modifier.fillMaxSize().background(Bg).padding(horizontal = 48.dp, vertical = 27.dp)) {
        Text("htv server", color = TextColor, fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text(
            if (settings.hasBuiltIn) "Leave the address empty to use the built-in server."
            else "The address of your htv server, like http://192.168.1.20:8787",
            color = Muted, fontSize = 16.sp, modifier = Modifier.padding(top = 6.dp),
        )
        Spacer(Modifier.height(28.dp))
        Column(Modifier.width(640.dp)) {
            Field(
                "Server address", url, { url = it }, KeyboardType.Uri,
                if (onBack == null) Modifier.focusRequester(initial) else Modifier,
            )
            Spacer(Modifier.height(18.dp))
            Field("Token", token, { token = it }, KeyboardType.Password, secret = true)
            Spacer(Modifier.height(28.dp))
            Row {
                Button(
                    onClick = { settings.save(url, token); onSaved() },
                    enabled = url.isNotBlank() || settings.hasBuiltIn,
                ) { Text("Save") }
                if (onBack != null) {
                    Spacer(Modifier.width(12.dp))
                    OutlinedButton(onClick = onBack, modifier = Modifier.focusRequester(initial)) { Text("Cancel") }
                }
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { initial.requestFocus() } }
}

@Composable
private fun Field(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    type: KeyboardType,
    modifier: Modifier = Modifier,
    secret: Boolean = false,
) {
    var focused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    Text(label, color = Muted, fontSize = 14.sp)
    Spacer(Modifier.height(6.dp))
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        textStyle = TextStyle(color = TextColor, fontSize = 20.sp),
        cursorBrush = SolidColor(Accent),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = ImeAction.Next, autoCorrectEnabled = false),
        modifier = modifier
            .fillMaxWidth()
            .onFocusChanged { focused = it.isFocused }
            // A text field keeps the D-pad for its cursor; let up/down move between controls.
            .onPreviewKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (e.key) {
                    Key.DirectionDown -> focusManager.moveFocus(FocusDirection.Down)
                    Key.DirectionUp -> focusManager.moveFocus(FocusDirection.Up)
                    else -> false
                }
            }
            .background(Panel, RoundedCornerShape(8.dp))
            .border(if (focused) 2.dp else 1.dp, if (focused) Accent else BorderColor, RoundedCornerShape(8.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp),
    )
}
