<script setup lang="ts">
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

export interface OfflineReminderConfig {
  channel: string
  endpoint: string
  token: string
  secret: string
  title: string
  msg: string
  offlineDeleteSec: number
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPass?: string
  senderName?: string
  recipientEmail?: string
  emailContent?: string
  useGlobalMailer?: boolean
}

defineProps<{
  channelOptions: { label: string, value: string | number }[]
  currentChannelDocUrl: string
  saving: boolean
  testing: boolean
  showSave?: boolean
  globalMailerAvailable?: boolean
}>()

const emit = defineEmits<{
  openDocs: []
  test: []
  save: []
}>()

const config = defineModel<OfflineReminderConfig>('config', { required: true })

const offlineChannel = computed(() => String(config.value.channel || '').trim().toLowerCase())
const isDingTalkChannel = computed(() => offlineChannel.value === 'dingtalk')
const isMeowChannel = computed(() => offlineChannel.value === 'meow')
const isSmtpChannel = computed(() => offlineChannel.value === 'smtp')
const channelUsesEndpoint = computed(() => offlineChannel.value === 'webhook' || isDingTalkChannel.value)
const endpointLabel = computed(() => isDingTalkChannel.value ? 'Webhook 地址' : '接口地址')
const endpointPlaceholder = computed(() => isDingTalkChannel.value
  ? '从钉钉群机器人设置页复制完整 Webhook'
  : '接收消息的接口地址')
const tokenLabel = computed(() => isMeowChannel.value ? '昵称' : 'Token')
const tokenPlaceholder = computed(() => isMeowChannel.value
  ? 'MeoW 注册昵称'
  : '接收端 token')
</script>

<template>
  <div class="farm-card rounded-lg p-4">
    <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
      <span class="i-carbon-notification" />
      下线提醒
    </h4>

    <div class="space-y-3">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-700 font-medium dark:text-gray-300">推送渠道</span>
            <BaseButton
              variant="text"
              size="sm"
              :disabled="!currentChannelDocUrl"
              @click="emit('openDocs')"
            >
              官网
            </BaseButton>
          </div>
          <BaseSelect
            v-model="config.channel"
            :options="channelOptions"
          />
        </div>
        <BaseInput
          v-if="!isSmtpChannel"
          v-model.number="config.offlineDeleteSec"
          label="离线删除账号 (秒)"
          type="number"
          min="0"
          placeholder="0 表示不删除"
        />
        <BaseInput
          v-else-if="!config.useGlobalMailer"
          v-model.number="config.smtpPort"
          label="SMTP 端口"
          type="number"
          min="1"
          max="65535"
          placeholder="465（SSL）"
        />
        <BaseInput
          v-else
          v-model.number="config.offlineDeleteSec"
          label="离线删除账号 (秒)"
          type="number"
          min="0"
          placeholder="0 表示不删除"
        />
      </div>

      <template v-if="isSmtpChannel">
        <!-- 使用管理员配置的邮件服务：开启后免填 SMTP 账号密码 -->
        <div class="border border-gray-200 rounded-lg bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40">
          <BaseSwitch
            v-model="config.useGlobalMailer"
            label="使用管理员配置的邮件服务"
            :disabled="!globalMailerAvailable"
          />
          <p class="mt-1 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            <template v-if="globalMailerAvailable">
              开启后不用填写服务器与授权码，只需填收件邮箱，即可收到本账号下挂机账号的掉线提醒。
            </template>
            <template v-else>
              管理员还没有在「管理后台 → 全局设置」里配置邮件服务，暂时只能自己填写 SMTP。
            </template>
          </p>
        </div>

        <div v-if="!config.useGlobalMailer" class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.smtpHost"
            label="SMTP 服务器地址"
            type="text"
            placeholder="如 smtp.qq.com"
          />
          <BaseInput
            v-model="config.smtpUser"
            label="邮箱账号"
            type="text"
            placeholder="发件人邮箱地址"
          />
        </div>

        <div v-if="!config.useGlobalMailer" class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.smtpPass"
            label="授权码"
            type="password"
            placeholder="SMTP 授权码（非邮箱登录密码）"
          />
          <BaseInput
            v-model="config.senderName"
            label="发件人名称"
            type="text"
            placeholder="发件人显示名称"
          />
        </div>

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.recipientEmail"
            label="收件人邮箱"
            type="text"
            placeholder="接收通知的邮箱地址"
          />
          <BaseInput
            v-model="config.emailContent"
            label="发信内容"
            type="text"
            placeholder="掉线提醒的自定义内容"
          />
        </div>
        <p class="text-xs text-gray-500 leading-relaxed dark:text-gray-400">
          QQ 邮箱等需要在邮箱设置里开启 SMTP 服务并获取授权码；端口 465 走 SSL，其他端口（如 587）走 STARTTLS/明文。
        </p>
      </template>

      <template v-else>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-if="channelUsesEndpoint"
            v-model="config.endpoint"
            :label="endpointLabel"
            type="text"
            :placeholder="endpointPlaceholder"
          />

          <BaseInput
            v-if="!isDingTalkChannel"
            v-model="config.token"
            :label="tokenLabel"
            type="text"
            :placeholder="tokenPlaceholder"
          />

          <template v-else>
            <BaseInput
              v-model="config.secret"
              label="加签密钥（可选）"
              type="password"
              placeholder="仅在机器人开启加签时填写 SEC..."
            />
          </template>
        </div>

        <p v-if="isDingTalkChannel" class="text-xs text-gray-500 leading-relaxed dark:text-gray-400">
          从群机器人的设置页复制完整 Webhook；只有开启“加签”时才需要填写加签密钥。
        </p>

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.title"
            label="标题"
            type="text"
            placeholder="提醒标题"
          />
          <BaseInput
            v-model="config.msg"
            label="内容"
            type="text"
            placeholder="提醒内容"
          />
        </div>
      </template>
    </div>

    <div class="mt-4 flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
      <BaseButton
        variant="secondary"
        size="sm"
        :loading="testing"
        :disabled="saving"
        @click="emit('test')"
      >
        测试通知
      </BaseButton>
      <BaseButton
        v-if="showSave !== false"
        variant="primary"
        size="sm"
        :loading="saving"
        :disabled="testing"
        @click="emit('save')"
      >
        保存下线提醒设置
      </BaseButton>
    </div>
  </div>
</template>
