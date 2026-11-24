package com.designdynastystudios.fissile;

import android.os.Bundle;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A turn-based game is mostly looking and thinking, not touching. The
        // screen timing out mid-thought and locking the phone is the most common
        // way a pass-and-play match gets abandoned.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        goFullscreen();
    }

    @Override
    public void onResume() {
        super.onResume();
        goFullscreen();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // A dialog, the keyboard or the notification shade can bring the bars
        // back; hide them again as soon as the game has focus.
        if (hasFocus) goFullscreen();
    }

    /**
     * Immersive full screen: no status bar, no navigation bar. A swipe from
     * the edge shows them briefly (so Back and Home still work) and they hide
     * again on their own. The cutout mode is left at its default, so on a
     * notched phone the game sits below the notch instead of under it.
     */
    private void goFullscreen() {
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
    }
}
