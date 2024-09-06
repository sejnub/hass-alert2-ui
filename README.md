<!-- ~/tmp/general-env/bin/grip -b ~/tmp/hass-alert2-ui/README.md -->

# Alert2 UI

This repository contains a HomeAssistant Lovelace module that includes a card to display and interact with [Alert2](https://github.com/redstone99/hass-alert2) alerts.  It also enhances the information shown in the "more-info" dialog when viewing Alert2 entities in entity cards. We recommend first installing [Alert2](https://github.com/redstone99/hass-alert2).

![Alert2 overview card](resources/overview.png)

## Install

### HACS install (recommended)

1. If HACS is not installed, follow HACS installation and configuration at https://hacs.xyz/.

1. Click the button below or visit the HACS pane and add `https://github.com/redstone99/hass-alert2-ui.git` as an `Dashboard` by following [these instructions](https://hacs.xyz/docs/faq/custom_repositories/).

    [![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=redstone99&repository=hass-alert2-ui&category=dashboard)

1. Install the dashboard component.

1. Reload the UI

### Manual install

1. Download the `alert2.js` file from the repository [release section](https://github.com/redstone99/hass-alert2-ui/releases) and extract it.

   We do not recommend downloading directly from the `main` branch.

1. Create the directory `www` in your Home Assistant configuration directory if it doesn't already exist.

   Your configuration directory is the directory with `configuration.yaml`. It is commonly `/config`, or may be something like `~/.home-assistant/` for Linux installations.
   
1. Copy `alert2.js` from the `www` directory in this project into the directory `www` in your config.

   Your config directory should look similar to this after copying:
   
        <config dir>/configuration.yaml
        <config dir>/www/alert2.js
        <config dir>/custom_components/alert2/__init__.py
        <config dir>/custom_components/alert2/sensor.py
         ... etc...

## Setup

Setup is done through editing your `configuration.yaml` file.

1. If you're configuring Lovelace in YAML mode, add the two lines in bold to the `resources` subsection of the lovelace section of `configuration.yaml`:

    <pre>lovelace:
      mode: yaml
      resources:
        <b>- url: /local/alert2.js</b>
          <b>type: module</b></pre>


    If you configure Lovelace via the UI, then enable "Advanced mode" in your user profile, then click on Settings -> Dashboards -> Resources.  "Resources" may appear only in the triple vertical dots on the upper right of the dashboards page. Click on "Add Resource".


1. `alert2.js` defines a custom UI card called `alert2-overview`. If you are using the yaml config for lovelace, you can add this card to your dashboard by adding it to the list of cards in a view, like (in bold):

<pre>views:
- title: Monitoring
  name: Example
  cards:
  <b>- type: "custom:alert2-overview"</b>
  - type: entities
    ...</pre>


1. Restart HomeAssistant and reload the UI

## Usage

The `alert2-overview` Lovelace card lists recently active alerts, as well as snoozed or disabled alerts.  A slider at the top of the card controls the time window covered. Each line shows the status of the alert, including when it last fired, how many times it fired since the last notification, and whether it has been ack'ed, snoozed or disabled.  Each alert will show an "ACK" button if it hasn't been acked already. The button "ACK ALL" will ack all alerts, not just the ones displayed.

![Alert2 overview card](resources/overview.png)

### Detailed alert info

If you click on a specific alert listed in the alert overview, a dialog pops up with detailed info on the alert and notification controls. Example:

![Alert2 overview card](resources/more-info.png)

The first line is a repeat of the alert status.

The second "Previous Firings" section lists each firing over the previous 24 hours.  The time when the alert turned on or off is listed as well as the message template text rendered when the alert fired.  The "PREV DAY" button lets you look at firings one day earlier and "RESET" returns the listing to the firings over the past 24 hours.  You may see events listed that have time `unknown`. This are extra events inserted due to either HomeAssistant restarting or the first time an alert is created (TODO - filter these spurious events out).

The "Notifications" section lets you snooze or disable notifications. Select an option and click "Update".

### Other ways to view alerts

You may also add alert2 entities to entities cards and other cards that support entities.  If you click on an alert shown in such a situation, you'll see a popup (called a "more-info dialog") similar to the one shown above.  However, since Alert2 isn't integrated into the core HomeAssistant, that dialog will include some extra default sections like "history", but will also include the sections described above.
