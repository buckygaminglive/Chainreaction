package com.designdynastystudios.fissile;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A turn-based game is mostly looking and thinking, not touching. The
        // screen timing out mid-thought and locking the phone is the most common
        // way a pass-and-play match gets abandoned.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
