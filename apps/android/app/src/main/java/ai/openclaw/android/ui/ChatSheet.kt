package ai.openclaw.android.ui

import ai.openclaw.android.MainViewModel
import ai.openclaw.android.ui.chat.ChatSheetContent
import androidx.compose.runtime.Composable

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
