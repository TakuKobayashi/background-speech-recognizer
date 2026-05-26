package com.example.whispertranscriber.ui

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.example.whispertranscriber.R
import com.example.whispertranscriber.service.TranscriptionService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class HistoryAdapter(
    private val onLongClick: (TranscriptionService.TranscriptionResult) -> Unit = {},
) : ListAdapter<TranscriptionService.TranscriptionResult, HistoryAdapter.VH>(DIFF) {

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<TranscriptionService.TranscriptionResult>() {
            override fun areItemsTheSame(a: TranscriptionService.TranscriptionResult, b: TranscriptionService.TranscriptionResult) = a.timestamp == b.timestamp
            override fun areContentsTheSame(a: TranscriptionService.TranscriptionResult, b: TranscriptionService.TranscriptionResult) = a == b
        }
        private val TIME_FMT = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        private val DATE_FMT = SimpleDateFormat("M/d HH:mm:ss", Locale.getDefault())
    }

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        val time:   TextView = view.findViewById(R.id.text_time)
        val dur:    TextView = view.findViewById(R.id.text_duration)
        val text:   TextView = view.findViewById(R.id.text_transcription)
        init { view.setOnLongClickListener { onLongClick(getItem(bindingAdapterPosition)); true } }
    }

    override fun onCreateViewHolder(p: ViewGroup, v: Int) =
        VH(LayoutInflater.from(p.context).inflate(R.layout.item_transcription, p, false))

    override fun onBindViewHolder(h: VH, pos: Int) {
        val item = getItem(pos)
        val date = Date(item.timestamp)
        h.time.text = if (DateUtils.isToday(item.timestamp)) TIME_FMT.format(date) else DATE_FMT.format(date)
        h.dur.text  = "%.1fs".format(item.durationSeconds)
        h.text.text = item.text
    }
}
