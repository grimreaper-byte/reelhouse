package app.reelhouse.android.data.pairing

import android.content.Context
import android.net.ConnectivityManager
import java.net.InetAddress
import java.net.NetworkInterface

/** This device's addresses on the network it's using (Wi-Fi or a cable), for [homeAddress] to choose from. */
fun deviceAddresses(context: Context): List<InetAddress> {
    val cm = context.getSystemService(ConnectivityManager::class.java)
    val active = runCatching {
        cm?.activeNetwork?.let { n -> cm.getLinkProperties(n)?.linkAddresses?.map { it.address } }
    }.getOrNull().orEmpty()
    if (active.isNotEmpty()) return active
    return runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
    }.getOrDefault(emptyList())
}
