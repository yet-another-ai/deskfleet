package ai.yetanother.deskfleet.ui

import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.ui.auth.*
import ai.yetanother.deskfleet.ui.chrome.DesktopWorkspaceShell
import ai.yetanother.deskfleet.ui.chrome.MobileWorkspaceShell
import ai.yetanother.deskfleet.ui.common.ErrorNotice
import ai.yetanother.deskfleet.ui.theme.DeskFleetTheme
import ai.yetanother.deskfleet.ui.theme.ProvideDeskFleetI18n
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Root Compose Multiplatform UI shell shared across macOS, Linux, Windows, iOS, and Android.
 * Breakpoint `< 1024.dp` or `isMobile` activates `MobileWorkspaceShell`; `>= 1024.dp` activates `DesktopWorkspaceShell`.
 */
@Composable
fun DeskFleetApp(
    controller: AppController = remember { AppController() },
) {
    val prefs by controller.preferences.collectAsState()
    val account by controller.central.account.collectAsState()
    val onboardingDone by controller.onboardingCompleted.collectAsState()
    val teams by controller.teams.collectAsState()
    val showAddMachine by controller.showAddMachineDialog.collectAsState()
    val showCreateTeam by controller.showCreateTeamDialog.collectAsState()
    val showReauth by controller.showReauthDialog.collectAsState()
    val bannerErr by controller.globalBannerError.collectAsState()

    val signedIn = !account.token.isNullOrBlank() || account.user != null

    ProvideDeskFleetI18n(preferredLocale = prefs.locale) {
        DeskFleetTheme(preferences = prefs) {
            BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
                val useMobileLayout = controller.hostBridge.platform.isMobile || maxWidth < 1024.dp
                val isWebAuthRoute = controller.hostBridge.platform.isWeb &&
                    controller.hostBridge.currentWebPath.startsWith("/auth/")

                when {
                    isWebAuthRoute -> WebAuthRoutesView(controller = controller)
                    !signedIn -> AuthPage(controller = controller)
                    !onboardingDone -> WelcomePage(controller = controller)
                    teams.isEmpty() -> TeamOnboardingView(controller = controller)
                    useMobileLayout -> MobileWorkspaceShell(controller = controller)
                    else -> DesktopWorkspaceShell(controller = controller)
                }

                if (!bannerErr.isNullOrEmpty()) {
                    Box(
                        modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                    ) {
                        ErrorNotice(
                            message = bannerErr!!,
                            suppressBillingPricing = controller.hostBridge.platform.suppressBillingPricing,
                            onDismiss = { controller.dismissBannerError() },
                        )
                    }
                }

                AddMachineDialog(
                    open = showAddMachine,
                    controller = controller,
                    onClose = { controller.setShowAddMachineDialog(false) },
                )
                CreateTeamDialog(
                    open = showCreateTeam,
                    controller = controller,
                    onClose = { controller.setShowCreateTeamDialog(false) },
                )
                ReauthDialog(
                    open = showReauth,
                    controller = controller,
                    onClose = { controller.setShowReauthDialog(false) },
                )
            }
        }
    }
}
