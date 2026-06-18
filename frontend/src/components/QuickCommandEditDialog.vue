<template>
  <el-dialog
    v-model="visible"
    :title="editingId ? t('quickCommands.editCommand') : t('quickCommands.addCommand')"
    width="480px"
    :close-on-click-modal="false"
    @close="resetForm"
  >
    <el-form label-width="60px">
      <el-form-item :label="t('quickCommands.name')">
        <el-input
          v-model="formName"
          :placeholder="t('quickCommands.namePlaceholder')"
          maxlength="50"
        />
      </el-form-item>
      <el-form-item :label="t('quickCommands.group')">
        <el-select v-model="formGroupId" :placeholder="t('quickCommands.noGroup')" clearable>
          <el-option
            v-for="g in store.groups"
            :key="g.id"
            :label="g.name"
            :value="g.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('quickCommands.command')">
        <el-input
          v-model="formCommand"
          type="textarea"
          :rows="4"
          :placeholder="t('quickCommands.commandPlaceholder')"
          class="command-textarea"
        />
      </el-form-item>
    </el-form>

    <div v-if="errorMsg" class="form-error">{{ errorMsg }}</div>

    <template #footer>
      <el-button @click="visible = false">{{ t('quickCommands.cancel') }}</el-button>
      <el-button type="primary" :disabled="!formCommand.trim()" @click="handleSave">
        {{ t('quickCommands.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useQuickCommandStore } from '../stores/quickCommandStore'
import { useI18n } from '../i18n'

const { t } = useI18n()
const store = useQuickCommandStore()

const props = defineProps<{
  modelValue: boolean
  editingId?: string
  initialName?: string
  initialCommand?: string
  initialGroupId?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const formName = ref('')
const formCommand = ref('')
const formGroupId = ref<string | undefined>(undefined)
const errorMsg = ref('')

watch(visible, (v) => {
  if (v) {
    formName.value = props.initialName || ''
    formCommand.value = props.initialCommand || ''
    formGroupId.value = props.initialGroupId || undefined
    errorMsg.value = ''
  }
})

function handleSave() {
  const cmd = formCommand.value.trim()
  if (!cmd) {
    errorMsg.value = t('quickCommands.commandRequired')
    return
  }
  if (props.editingId) {
    store.updateCommand(props.editingId, formName.value || undefined, cmd, formGroupId.value)
  } else {
    store.addCommand(formName.value || undefined, cmd, formGroupId.value)
  }
  visible.value = false
  resetForm()
}

function resetForm() {
  formName.value = ''
  formCommand.value = ''
  formGroupId.value = undefined
  errorMsg.value = ''
}
</script>

<style scoped>
.command-textarea :deep(textarea) {
  font-family: var(--font-mono, 'Consolas', 'Courier New', monospace);
}
.form-error {
  color: var(--danger-color, #f56c6c);
  font-size: 12px;
  margin-top: -8px;
  margin-bottom: 8px;
}
</style>
