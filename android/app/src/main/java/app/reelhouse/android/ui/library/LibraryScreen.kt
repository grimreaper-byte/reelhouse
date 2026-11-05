package app.reelhouse.android.ui.library

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.container
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.ui.common.CenteredMessage
import app.reelhouse.android.ui.common.LoadableContent
import app.reelhouse.android.ui.components.PosterCard
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(libraryId: Long, name: String, onOpenItem: (Item) -> Unit, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val vm = viewModel(key = "library-$libraryId") { LibraryViewModel(c, libraryId) }
    val items by vm.items.collectAsState()
    val options by vm.options.collectAsState()
    val genres by vm.genres.collectAsState()
    val refreshing by vm.refreshing.collectAsState()
    var sortMenu by remember { mutableStateOf(false) }
    var genreMenu by remember { mutableStateOf(false) }

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        items.data?.let { Text(countLabel(it.size), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim) }
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                actions = {
                    Box {
                        IconButton(onClick = { sortMenu = true }) { Icon(Icons.AutoMirrored.Filled.Sort, contentDescription = "Sort") }
                        DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                            for (s in Sort.entries) {
                                DropdownMenuItem(
                                    text = { Text(s.label) },
                                    trailingIcon = { if (s == options.sort) Icon(Icons.Filled.Check, contentDescription = "Selected") },
                                    onClick = {
                                        sortMenu = false
                                        vm.setOptions(options.copy(sort = s, descending = s.descending))
                                    },
                                )
                            }
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text(if (options.descending) "Descending" else "Ascending") },
                                onClick = {
                                    sortMenu = false
                                    vm.setOptions(options.copy(descending = !options.descending))
                                },
                            )
                        }
                    }
                },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (f in Filter.entries) {
                    FilterChip(selected = options.filter == f, onClick = { vm.setOptions(options.copy(filter = f)) }, label = { Text(f.label) })
                }
                if (genres.isNotEmpty()) {
                    Box {
                        FilterChip(
                            selected = options.genre != null,
                            onClick = { genreMenu = true },
                            label = { Text(options.genre ?: "Genre") },
                            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, contentDescription = null) },
                        )
                        DropdownMenu(expanded = genreMenu, onDismissRequest = { genreMenu = false }) {
                            DropdownMenuItem(text = { Text("All genres") }, onClick = {
                                genreMenu = false
                                vm.setOptions(options.copy(genre = null))
                            })
                            for (g in genres) {
                                DropdownMenuItem(
                                    text = { Text("${g.genre} (${g.n})") },
                                    trailingIcon = { if (g.genre == options.genre) Icon(Icons.Filled.Check, contentDescription = "Selected") },
                                    onClick = {
                                        genreMenu = false
                                        vm.setOptions(options.copy(genre = g.genre))
                                    },
                                )
                            }
                        }
                    }
                }
            }
            LoadableContent(items, onRetry = vm::load) { list ->
                PullToRefreshBox(isRefreshing = refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
                    if (list.isEmpty()) {
                        CenteredMessage(if (options.filter == Filter.All && options.genre == null) "This library is empty." else "Nothing matches.")
                    } else {
                        LazyVerticalGrid(
                            columns = GridCells.Adaptive(minSize = 104.dp),
                            contentPadding = PaddingValues(16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            items(list, key = { it.id }) { item -> PosterCard(item, onClick = { onOpenItem(item) }, fill = true) }
                        }
                    }
                }
            }
        }
    }
}

private fun countLabel(n: Int) = if (n == 1) "1 title" else "$n titles"
