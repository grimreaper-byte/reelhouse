# Privacy policy: the Reelhouse app for Android

Last updated: 14 November 2026

Reelhouse is software you run yourself. The Reelhouse app for Android connects only to the Reelhouse server you pair
it with or sign in to: your own, or one whose owner gave you an account. The people who make Reelhouse run no servers
for the app and receive no data from it. A pairing link opens a page on Reelhouse's website on the way, which never
sees the code in it (see **Pairing links** below).

## What the app sends, and where

Only to the Reelhouse server you connect it to:

- your username and password when you sign in (the server answers with a sign-in token, which the app keeps instead);
- the device's name, so you can recognise it in the server's list of signed-in devices;
- what you play and how far you got, watched marks, what you search for, films you ask the server's admin to add
  (Requests), downloads you start, and recordings you schedule;
- a picture for your account, if you choose one;
- for the app tunnel, when you pair at home, the public half of a key made on the phone (the private half never leaves
  it). Paired away from home, the tunnel uses a key your server put in the pairing code.

What that server keeps is up to whoever runs it. Reelhouse's server keeps your watch history and resume points, and a
log of what was played on which device, which its admins can see.

## What stays on your phone

The server's address, your sign-in token, your settings, the tunnel's keys and the videos you download. They stay
until you sign out, delete them, or uninstall the app.

## Camera

Only to scan the pairing QR code your Reelhouse server shows. The picture is read on the phone and is not saved or
sent anywhere. You can pair without the camera by typing the code instead.

## Pairing links

Someone who runs Reelhouse can send you a pairing link by email or a message. It opens a page on Reelhouse's website
(reelhouseapp.com) that hands the link to the app. The pairing code and the tunnel's keys are in the part of the link
after the `#`, which your browser keeps to itself and never sends to the website. The website gets only the request
for the page, as for any web page, and keeps no log of it.

## Notifications

Only to show how downloads are going.

## Nothing else

No ads, no analytics, no crash reporting, and no third-party services in the app. No data is sold or shared. Film
details and artwork come through your Reelhouse server (which may fetch them from TMDB), not from the app directly.

## Deleting your account and data

Your Reelhouse account, and everything kept with it (watch history, resume points, your picture, the devices you
signed in on), is on the Reelhouse server you use. The makers of Reelhouse hold no account or data of yours, so
there is nothing to delete with us. To delete it:

1. **If someone else runs your Reelhouse server,** ask them to delete your account. They do it in Reelhouse's web app
   under **Settings → Users**, with the delete button next to your name. That removes your account, its watch
   history and picture, and signs out your devices.
2. **If you run the server yourself,** delete accounts the same way. To remove everything, stop Reelhouse and delete
   its data folder (`/config` in Docker).
3. **On your phone,** open the app's **Settings** and choose **Sign out**, which removes the sign-in and the tunnel's
   keys. Delete downloaded videos under **Downloads**, or uninstall the app, which removes everything it stored.

## Changes and questions

Changes to this policy are made in this file, with the date above. For questions, open an issue at
<https://github.com/grimreaper-byte/reelhouse/issues>.
