package dev.plainwright.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

// Disposable, offline fixture for native Appium validation; no Android project/Gradle dependency.
public class MobileAndroidFixture extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ScrollView scroll = new ScrollView(this);
        scroll.setContentDescription("Fixture results list");
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(32, 100, 32, 80);
        scroll.addView(content);
        TextView title = new TextView(this);
        title.setText("Plainwright Android Fixture");
        title.setTextSize(22);
        content.addView(title);
        EditText message = new EditText(this);
        message.setContentDescription("Message");
        message.setHint("Message");
        message.setSingleLine(true);
        content.addView(message);
        Switch enabled = new Switch(this);
        enabled.setText("Enable preview");
        enabled.setContentDescription("Enable preview");
        content.addView(enabled);
        Button preview = new Button(this);
        preview.setText("Preview");
        content.addView(preview);
        TextView result = new TextView(this);
        result.setText("Preview is empty");
        result.setTextSize(18);
        content.addView(result);
        preview.setOnClickListener(view -> result.setText(enabled.isChecked()
            ? "Preview: " + message.getText().toString() : "Preview is disabled"));
        Button hold = new Button(this);
        hold.setText("Hold for details");
        content.addView(hold);
        TextView details = new TextView(this);
        details.setText("Details are hidden");
        content.addView(details);
        hold.setOnLongClickListener(view -> { details.setText("Details are visible"); return true; });
        // Spatial targets: right-to-left, so Alpha comes first in the tree but is drawn on the right of Beta.
        LinearLayout choices = new LinearLayout(this);
        choices.setOrientation(LinearLayout.HORIZONTAL);
        choices.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        content.addView(choices);
        TextView chosen = new TextView(this);
        chosen.setText("Chosen: none");
        content.addView(chosen);
        for (String name : new String[] {"Alpha", "Beta"}) {
            Button choice = new Button(this);
            choice.setText(name);
            choice.setAllCaps(false);
            choice.setOnClickListener(view -> chosen.setText("Chosen: " + name));
            choices.addView(choice, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        }
        for (int i = 1; i <= 25; i++) {
            TextView row = new TextView(this);
            row.setText("Fixture row " + i);
            row.setPadding(0, 24, 0, 24);
            content.addView(row);
        }
        setContentView(scroll);
    }
}
